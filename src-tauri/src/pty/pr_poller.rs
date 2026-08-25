use crate::git::hosted_reviews::{
    poll_pass_once,
    unix_now_ms, PollerConfig,
};
use crate::pty::ipc_protocol::DaemonEvent;
use std::sync::Arc;
use crate::pty::daemon_server::DaemonServer;


// PR status poller: periodic pass plus push-burst wakeups. Pure move.

impl DaemonServer {
    /// One synchronous poll pass over all linked worktrees; also the manual trigger.
    pub fn run_pr_poll_pass(&self) -> usize {
        let Some(registry_path) = self.worktree_registry_path.clone() else {
            return 0;
        };
        let client = Arc::clone(&self.pr_client);
        let mut published_ids: Vec<Option<String>> = Vec::new();
        let fetched = {
            let mut state = self.pr_poller_state.lock();
            poll_pass_once(
                &mut state,
                &PollerConfig::default(),
                &registry_path,
                client.as_ref(),
                unix_now_ms(),
                &mut |id| published_ids.push(id),
            )
        };
        for worktree_id in published_ids {
            self.publish_global(DaemonEvent::PrChanged { worktree_id });
        }
        fetched
    }

    /// Background PR status loop: 60s tick plus immediate pass on push burst.
    pub fn start_pr_poller(&self) {
        let server = self.shared_clone();
        tokio::spawn(async move {
            let config = PollerConfig::default();
            // Notify permits persist between waits, so a push landing mid-pass still wakes the next select.
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(config.tick) => {}
                    _ = server.pr_push_burst.notified() => {}
                }
                let pass_server = Arc::clone(&server);
                let _ =
                    tokio::task::spawn_blocking(move || pass_server.run_pr_poll_pass()).await;
            }
        });
    }
}

