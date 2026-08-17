use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// State representing an active browser session or child webview.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct BrowserState {
    pub url: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub visible: bool,
    pub open: bool,
}

/// Thread-safe manager holding browser state and coordinates.
#[derive(Clone, Default)]
pub struct BrowserManager {
    state: Arc<Mutex<BrowserState>>,
}

#[allow(dead_code)]
impl BrowserManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(BrowserState::default())),
        }
    }

    pub fn set_open(&self, url: String, x: i32, y: i32, width: u32, height: u32) {
        let mut s = self.state.lock();
        s.url = url;
        s.x = x;
        s.y = y;
        s.width = width;
        s.height = height;
        s.visible = true;
        s.open = true;
    }

    pub fn set_url(&self, url: String) {
        let mut s = self.state.lock();
        s.url = url;
    }

    pub fn set_bounds(&self, x: i32, y: i32, width: u32, height: u32) {
        let mut s = self.state.lock();
        s.x = x;
        s.y = y;
        s.width = width;
        s.height = height;
    }

    pub fn set_visible(&self, visible: bool) {
        let mut s = self.state.lock();
        s.visible = visible;
    }

    pub fn get_state(&self) -> BrowserState {
        self.state.lock().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_browser_manager_initial_state() {
        let manager = BrowserManager::new();
        let state = manager.get_state();
        assert_eq!(state.url, "");
        assert_eq!(state.visible, false);
        assert_eq!(state.open, false);
    }

    #[test]
    fn test_browser_manager_set_open_and_bounds() {
        let manager = BrowserManager::new();
        manager.set_open("http://localhost:5173".into(), 10, 50, 800, 600);
        let state = manager.get_state();
        assert_eq!(state.url, "http://localhost:5173");
        assert_eq!(state.x, 10);
        assert_eq!(state.y, 50);
        assert_eq!(state.width, 800);
        assert_eq!(state.height, 600);
        assert_eq!(state.visible, true);
        assert_eq!(state.open, true);

        manager.set_bounds(20, 60, 1024, 768);
        let state2 = manager.get_state();
        assert_eq!(state2.x, 20);
        assert_eq!(state2.y, 60);
        assert_eq!(state2.width, 1024);
        assert_eq!(state2.height, 768);
    }

    #[test]
    fn test_browser_manager_set_visible_and_url() {
        let manager = BrowserManager::new();
        manager.set_url("https://github.com".into());
        manager.set_visible(false);
        let state = manager.get_state();
        assert_eq!(state.url, "https://github.com");
        assert_eq!(state.visible, false);
    }
}
