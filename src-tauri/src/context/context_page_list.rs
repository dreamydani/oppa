use serde::{Deserialize, Serialize};
use crate::context::models::ContextPage;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ContextPageList {
    pub items: Vec<ContextPage>,
    pub total: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_list_has_zero_total() {
        let list = ContextPageList::default();
        assert_eq!(list.items.len(), 0);
        assert_eq!(list.total, 0);
    }
}
