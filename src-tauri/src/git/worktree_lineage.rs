// Lineage integrity helpers over the registry graph; wired into commands in a later task.
#![allow(dead_code)]

use crate::git::worktree_registry::{WorktreeRecord, WorktreeRegistry};
use std::collections::{HashSet, VecDeque};

// Dangling refs accumulate after purges; pruning keeps lineage queries honest.
pub fn prune_orphaned_children(registry: &mut WorktreeRegistry) -> Vec<String> {
    let live: HashSet<String> = registry.worktrees.keys().cloned().collect();
    let ids: Vec<String> = registry.worktrees.keys().cloned().collect();
    let mut affected = Vec::new();
    for id in ids {
        let Some(record) = registry.worktrees.get_mut(&id) else {
            continue;
        };
        let before_children = record.child_worktree_ids.len();
        record.child_worktree_ids.retain(|child| live.contains(child));
        let parent_dangling = record
            .parent_worktree_id
            .as_ref()
            .map(|parent| !live.contains(parent))
            .unwrap_or(false);
        if parent_dangling {
            record.parent_worktree_id = None;
        }
        if parent_dangling || record.child_worktree_ids.len() != before_children {
            affected.push(id);
        }
    }
    affected.sort();
    affected
}

pub fn lineage_list(
    registry: &WorktreeRegistry,
    root_id: &str,
) -> Result<Vec<WorktreeRecord>, String> {
    if !registry.worktrees.contains_key(root_id) {
        return Err(format!("worktree not found: {root_id}"));
    }
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back(root_id.to_string());
    let mut seen: HashSet<String> = HashSet::from([root_id.to_string()]);
    let mut ordered = Vec::new();
    while let Some(current_id) = queue.pop_front() {
        let Some(record) = registry.get_worktree(&current_id) else {
            // Stale child refs are prune_orphaned_children's job; skip defensively.
            continue;
        };
        let mut children: Vec<WorktreeRecord> = record
            .child_worktree_ids
            .iter()
            .filter_map(|child| registry.get_worktree(child))
            .filter(|child| seen.insert(child.id.clone()))
            .cloned()
            .collect();
        children.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then(a.id.cmp(&b.id)));
        for child in children {
            queue.push_back(child.id);
        }
        ordered.push(record.clone());
    }
    Ok(ordered)
}

pub fn validate_no_cycle(
    registry: &WorktreeRegistry,
    parent_id: &str,
    candidate_child_id: &str,
) -> Result<(), String> {
    let mut cursor = Some(parent_id.to_string());
    while let Some(current) = cursor {
        if current == candidate_child_id {
            return Err("worktree lineage cycle detected".into());
        }
        cursor = registry
            .worktrees
            .get(&current)
            .and_then(|w| w.parent_worktree_id.clone());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn wt(id: &str, created_at_ms: u64) -> WorktreeRecord {
        WorktreeRecord {
            id: id.to_string(),
            repo_id: "sample".into(),
            name: id.to_string(),
            display_name: None,
            branch: format!("br-{id}"),
            path: PathBuf::from(format!("/ws/{id}")),
            base_ref: "main".into(),
            parent_worktree_id: None,
            child_worktree_ids: Vec::new(),
            workspace_status: Default::default(),
            retired: false,
            created_at_ms,
            linked_pr_url: None,
        }
    }

    fn chain() -> WorktreeRegistry {
        let mut reg = WorktreeRegistry::default();
        let mut a = wt("a", 1);
        let mut b = wt("b", 2);
        let mut c = wt("c", 3);
        b.parent_worktree_id = Some("a".into());
        c.parent_worktree_id = Some("b".into());
        a.child_worktree_ids = vec!["b".into()];
        b.child_worktree_ids = vec!["c".into()];
        reg.upsert_worktree(a);
        reg.upsert_worktree(b);
        reg.upsert_worktree(c);
        reg
    }

    #[test]
    fn prune_orphaned_children_removes_dangling_refs_both_directions() {
        let mut reg = chain();
        let mut stray = wt("stray", 4);
        stray.parent_worktree_id = Some("ghost-parent".into());
        reg.upsert_worktree(stray);
        reg.worktrees
            .get_mut("a")
            .unwrap()
            .child_worktree_ids
            .push("ghost-child".into());

        let affected = prune_orphaned_children(&mut reg);
        let mut expected = vec!["a".to_string(), "stray".to_string()];
        expected.sort();

        assert_eq!(affected, expected);
        assert_eq!(
            reg.get_worktree("a").unwrap().child_worktree_ids,
            vec!["b".to_string()]
        );
        assert_eq!(reg.get_worktree("stray").unwrap().parent_worktree_id, None);
    }

    #[test]
    fn prune_orphaned_children_is_noop_on_clean_registry() {
        let mut reg = chain();
        assert_eq!(prune_orphaned_children(&mut reg), Vec::<String>::new());
    }

    #[test]
    fn lineage_list_walks_breadth_first_with_created_at_sibling_order() {
        let mut reg = chain();
        let mut late_child = wt("late", 300);
        late_child.parent_worktree_id = Some("a".into());
        reg.upsert_worktree(late_child);
        reg.worktrees
            .get_mut("a")
            .unwrap()
            .child_worktree_ids
            .push("late".into());

        let mut grandchild = wt("grand", 200);
        grandchild.parent_worktree_id = Some("b".into());
        reg.upsert_worktree(grandchild);
        reg.worktrees
            .get_mut("b")
            .unwrap()
            .child_worktree_ids
            .push("grand".into());

        let ids: Vec<String> =
            lineage_list(&reg, "a").unwrap().iter().map(|w| w.id.clone()).collect();
        assert_eq!(ids, vec!["a", "b", "late", "c", "grand"]);
    }

    #[test]
    fn lineage_list_errs_on_missing_root() {
        let reg = chain();
        assert_eq!(
            lineage_list(&reg, "missing"),
            Err("worktree not found: missing".to_string())
        );
    }

    #[test]
    fn validate_no_cycle_catches_direct_self_and_transitive_cycles() {
        let reg = chain();
        // Direct: making "a" a child of its own child "b".
        assert_eq!(
            validate_no_cycle(&reg, "b", "a"),
            Err("worktree lineage cycle detected".to_string())
        );
        // Self-parent.
        assert_eq!(
            validate_no_cycle(&reg, "a", "a"),
            Err("worktree lineage cycle detected".to_string())
        );
        // Transitive: making "c" the parent of "a" closes a → b → c → a.
        assert!(validate_no_cycle(&reg, "c", "a").is_err());
        assert!(validate_no_cycle(&reg, "c", "z").is_ok());
        assert!(validate_no_cycle(&reg, "a", "z").is_ok());
    }
}
