use crate::agents::catalog::PromptDelivery;
use crate::git::worktree_registry::{RepoRecord, WorktreeRecord, WorktreeStatus};
use crate::git::worktrees::WorktreeListEntry;
use crate::pty::daemon_client::WorktreeAgentHandoff;
use crate::pty::ipc_protocol::{FleetSlot, FleetSlotResult, WorktreePsEntry};
use crate::pty::manager::PtyManager;
use serde::{Deserialize, Serialize};
use tauri::State;

// Worktree/repo commands: thin forwarders so the daemon stays the single owner
// of the registry (the GUI process never touches worktrees.json directly).

#[tauri::command(async)]
pub fn repo_add(manager: State<'_, PtyManager>, path: String) -> Result<Vec<RepoRecord>, String> {
    manager.get_client()?.repo_add(&path)
}

#[tauri::command(async)]
pub fn repo_list(manager: State<'_, PtyManager>) -> Result<Vec<RepoRecord>, String> {
    manager.get_client()?.repo_list()
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn worktree_create(
    manager: State<'_, PtyManager>,
    repo_path: String,
    name: Option<String>,
    branch: Option<String>,
    base_ref: Option<String>,
    parent_worktree_id: Option<String>,
    workspace_dir: Option<String>,
    nest_workspaces: Option<bool>,
) -> Result<Option<WorktreeRecord>, String> {
    let client = manager.get_client()?;
    client
        .worktree_create(
            &repo_path,
            name,
            branch,
            base_ref,
            parent_worktree_id,
            workspace_dir,
            nest_workspaces,
        )
        .map(Some)
}

#[tauri::command(async)]
pub fn worktree_list(manager: State<'_, PtyManager>) -> Result<Vec<WorktreeListEntry>, String> {
    manager.get_client()?.worktree_list()
}

/// Minimal agent descriptor for the GUI picker; launch details stay daemon-side.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileDto {
    pub id: String,
    pub display_name: String,
    // Deserialize-only compat: production payloads always carry these;
    // legacy shapes omit them and degrade gracefully.
    #[serde(default)]
    pub command: String,
    pub prompt_delivery: PromptDelivery,
    // PATH resolution at serve time; the GUI hides unavailable entries behind
    // a "Not detected" expander instead of pretending every CLI exists.
    #[serde(default)]
    pub available: bool,
}

fn agent_profiles_impl() -> Vec<AgentProfileDto> {
    crate::agents::catalog::profiles()
        .iter()
        .map(|p| AgentProfileDto {
            id: p.id.to_string(),
            display_name: p.display_name.to_string(),
            command: p.command.to_string(),
            prompt_delivery: p.prompt_delivery,
            available: crate::agents::catalog::resolve_command(p.command).is_some(),
        })
        .collect()
}

/// Static catalog read in-process; the frontend never hardcodes agent lists.
#[tauri::command(async)]
pub fn agent_profiles() -> Vec<AgentProfileDto> {
    agent_profiles_impl()
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn worktree_create_agent(
    manager: State<'_, PtyManager>,
    repo_path: String,
    name: Option<String>,
    branch: Option<String>,
    base_ref: Option<String>,
    parent_worktree_id: Option<String>,
    workspace_dir: Option<String>,
    nest_workspaces: Option<bool>,
    agent: Option<String>,
    prompt: Option<String>,
    command: Option<String>,
) -> Result<WorktreeAgentHandoff, String> {
    manager.get_client()?.create_worktree_with_agent(
        &repo_path,
        name,
        branch,
        base_ref,
        parent_worktree_id,
        workspace_dir,
        nest_workspaces,
        agent,
        prompt,
        command,
    )
}

// Fleet spawn: one invoke fans out every slot; per-slot errors ride the results.
#[tauri::command(async)]
pub fn worktree_create_fleet(
    manager: State<'_, PtyManager>,
    repo_path: String,
    base_ref: Option<String>,
    shared_prompt: Option<String>,
    slots: Vec<FleetSlot>,
) -> Result<Vec<FleetSlotResult>, String> {
    manager
        .get_client()?
        .create_worktree_fleet(&repo_path, base_ref, shared_prompt, slots)
}

#[tauri::command(async)]
pub fn worktree_show(
    manager: State<'_, PtyManager>,
    id: String,
) -> Result<Option<WorktreeRecord>, String> {
    manager.get_client()?.worktree_show(&id)
}

#[tauri::command(async)]
pub fn worktree_current(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<Option<WorktreeRecord>, String> {
    manager.get_client()?.worktree_current(&cwd)
}

#[tauri::command(async)]
pub fn worktree_set(
    manager: State<'_, PtyManager>,
    id: String,
    set_parent: bool,
    parent_worktree_id: Option<String>,
    workspace_status: Option<WorktreeStatus>,
    display_name: Option<String>,
) -> Result<Option<WorktreeRecord>, String> {
    let client = manager.get_client()?;
    client
        .worktree_set(
            &id,
            set_parent,
            parent_worktree_id,
            workspace_status,
            display_name,
        )
        .map(Some)
}

#[tauri::command(async)]
pub fn worktree_remove(
    manager: State<'_, PtyManager>,
    id: String,
    force: bool,
    delete_branch: bool,
) -> Result<(), String> {
    manager
        .get_client()?
        .worktree_remove(&id, force, delete_branch)
}

#[tauri::command(async)]
pub fn worktree_purge(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.get_client()?.worktree_purge(&id)
}

#[tauri::command(async)]
pub fn worktree_ps(manager: State<'_, PtyManager>) -> Result<Vec<WorktreePsEntry>, String> {
    manager.get_client()?.worktree_ps()
}

#[tauri::command(async)]
pub fn worktree_lineage(
    manager: State<'_, PtyManager>,
    id: String,
) -> Result<Vec<WorktreeRecord>, String> {
    manager.get_client()?.worktree_lineage(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_profiles_dto_mirrors_catalog_with_camel_case_keys() {
        let dtos = agent_profiles_impl();
        assert_eq!(dtos.len(), crate::agents::catalog::profiles().len());
        let json = serde_json::to_string(&dtos).unwrap();
        assert!(json.contains("\"displayName\":\"Claude Code\""));
        assert!(json.contains("\"command\":\"claude\""));
        assert!(json.contains("\"command\":\"cursor-agent\""));
        // Availability rides the same payload: the pseudo `generic` command
        // exists on no machine, so it pins the false case portably.
        assert!(json.contains("\"available\":"));
        let generic = dtos.iter().find(|d| d.id == "generic").expect("generic profile");
        assert!(!generic.available);

        // Pre-availability daemons omit the field; the GUI fail-opens on
        // absent, so legacy payloads must still parse (default false).
        let legacy = r#"[{"id":"claude","displayName":"Claude Code","promptDelivery":"arg"}]"#;
        let parsed: Vec<AgentProfileDto> = serde_json::from_str(legacy).expect("legacy profiles");
        assert!(!parsed[0].available);
        assert!(json.contains("\"promptDelivery\":\"arg\""));
        assert!(json.contains("\"promptDelivery\":\"stdin\""));
        assert!(!json.contains("display_name"), "must not leak snake_case");
    }
}
