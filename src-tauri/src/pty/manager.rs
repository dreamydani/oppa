use crate::pty::session::PtySession;
use std::collections::HashMap;

#[derive(Default)]
pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn sessions(&self) -> &HashMap<String, PtySession> {
        &self.sessions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_manager_is_empty() {
        let manager = PtyManager::new();
        assert!(manager.sessions().is_empty());
    }
}
