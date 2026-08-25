// Flow-control gate between the PTY reader thread and renderer ACKs.
// Condvar-based so an ack releases the paused reader immediately instead of
// at the next poll tick; the bounded wait keeps the old poll-tick semantics
// as a fallback for any missed wake.

use parking_lot::{Condvar, Mutex};
use std::time::{Duration, Instant};

pub struct PauseGate {
    paused: Mutex<bool>,
    cv: Condvar,
}

impl PauseGate {
    pub fn new() -> Self {
        Self {
            paused: Mutex::new(false),
            cv: Condvar::new(),
        }
    }

    pub fn pause(&self) {
        *self.paused.lock() = true;
    }

    pub fn unpause(&self) {
        let mut paused = self.paused.lock();
        if *paused {
            *paused = false;
            self.cv.notify_all();
        }
    }

    pub fn is_paused(&self) -> bool {
        *self.paused.lock()
    }

    /// Blocks while paused; wakes instantly on unpause(). Returns true when
    /// still paused after `max_wait`, false once released.
    pub fn wait_while_paused(&self, max_wait: Duration) -> bool {
        let deadline = Instant::now() + max_wait;
        let mut paused = self.paused.lock();
        while *paused {
            if Instant::now() >= deadline {
                return true;
            }
            let timed_out = self.cv.wait_until(&mut paused, deadline).timed_out();
            if !*paused {
                return false;
            }
            if timed_out {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn starts_unpaused_and_reports_not_paused_instantly() {
        let gate = PauseGate::new();
        assert!(!gate.is_paused());
        let start = Instant::now();
        assert!(!gate.wait_while_paused(Duration::from_secs(5)));
        assert!(start.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn times_out_still_paused_when_nobody_releases() {
        let gate = PauseGate::new();
        gate.pause();
        assert!(gate.is_paused());
        let start = Instant::now();
        assert!(gate.wait_while_paused(Duration::from_millis(60)));
        assert!(start.elapsed() >= Duration::from_millis(55));
    }

    #[test]
    fn unpause_from_another_thread_wakes_the_waiter_quickly() {
        let gate = Arc::new(PauseGate::new());
        gate.pause();

        let waiter = Arc::clone(&gate);
        let handle = std::thread::spawn(move || {
            waiter.wait_while_paused(Duration::from_secs(10))
        });

        // Give the waiter time to block, then release it.
        std::thread::sleep(Duration::from_millis(120));
        let release_at = Instant::now();
        gate.unpause();

        let still_paused = handle.join().expect("waiter joined");
        assert!(
            release_at.elapsed() < Duration::from_secs(2),
            "condvar wake must beat the 10s fallback wait"
        );
        assert!(!still_paused);
    }

    #[test]
    fn pause_after_release_parks_again() {
        let gate = PauseGate::new();
        gate.pause();
        gate.unpause();
        assert!(!gate.is_paused());
        gate.pause();
        assert!(gate.is_paused());
        assert!(gate.wait_while_paused(Duration::from_millis(40)));
    }
}
