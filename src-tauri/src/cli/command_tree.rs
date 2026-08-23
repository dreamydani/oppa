// Single clap tree shared by the binary parser and the agent-context catalog builder; keeps flags from drifting.
use clap::{CommandFactory, Parser, Subcommand};

#[derive(Parser)]
#[command(name = "oppa", version, about = "Oppa terminal CLI")]
pub struct Cli {
    #[arg(long, global = true)]
    pub json: bool,

    #[arg(long, global = true, default_value_t = 10_000)]
    pub timeout_ms: u64,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Show daemon liveness and active sessions
    Status,
    /// Launch the Oppa runtime (GUI/daemon), then wait for it to accept connections
    Open,
    /// Machine-readable context for coding agents
    AgentContext,
    /// Register and inspect repositories
    Repo {
        #[command(subcommand)]
        action: RepoAction,
    },
    /// Manage worktrees inside registered repositories
    Worktree {
        #[command(subcommand)]
        action: WorktreeAction,
    },
    /// Drive terminal sessions managed by the daemon
    Terminal {
        #[command(subcommand)]
        action: TerminalAction,
    },
    /// Source-control operations against a working copy directory
    Git {
        #[command(subcommand)]
        action: GitAction,
    },
}

#[derive(Subcommand)]
pub enum RepoAction {
    /// Register a repository by path
    Add { path: String },
    /// List registered repositories
    List,
    /// Show one repository's record
    Show { repo_id: String },
}

#[derive(Subcommand)]
pub enum WorktreeAction {
    /// List worktrees (retired tombstones only appear with --all)
    List {
        #[arg(long)]
        all: bool,
    },
    /// Show a single worktree record by id
    Show { id: String },
    /// Resolve the worktree containing a directory (defaults to the current directory)
    Current { cwd: Option<String> },
    /// Create a worktree in a registered repo
    Create {
        name: String,
        #[arg(long)]
        repo: String,
        #[arg(long)]
        branch: Option<String>,
        #[arg(long = "base-ref")]
        base_ref: Option<String>,
        #[arg(long = "parent-worktree")]
        parent_worktree: Option<String>,
        #[arg(long = "workspace-dir")]
        workspace_dir: Option<String>,
        #[arg(long = "nest-workspaces")]
        nest_workspaces: bool,
        /// Catalog agent id to launch inside the new worktree
        #[arg(long, conflicts_with = "command")]
        agent: Option<String>,
        /// First prompt handed to the launched agent
        #[arg(long)]
        prompt: Option<String>,
        /// Raw launch command line instead of a catalog agent id
        #[arg(long)]
        command: Option<String>,
    },
    /// Update status, display name, or parent of a worktree
    Set {
        id: String,
        #[arg(long)]
        status: Option<String>,
        #[arg(long = "display-name")]
        display_name: Option<String>,
        #[arg(long, conflicts_with = "no_parent")]
        parent: Option<String>,
        #[arg(long = "no-parent")]
        no_parent: bool,
    },
    /// Remove a worktree (tombstones its record)
    #[command(alias = "delete", alias = "remove")]
    Rm {
        id: String,
        #[arg(long)]
        force: bool,
        #[arg(long = "delete-branch")]
        delete_branch: bool,
    },
    /// Drop a tombstoned worktree record entirely
    Purge { id: String },
    /// Live sessions per worktree
    Ps,
    /// Show the parent/child tree rooted at a worktree
    Lineage { id: String },
}

#[derive(Subcommand)]
pub enum TerminalAction {
    /// List live session ids
    List,
    /// Show one session's pid, size, cwd, and worktree binding
    Show { id: String },
    /// Print the session's current screen text (plain, viewport only)
    Read {
        id: String,
        // M1 default IS the rendered screen; kept for forward compatibility
        #[arg(long)]
        screen: bool,
    },
    /// Send text to a session's input
    Send {
        id: String,
        #[arg(long)]
        text: String,
        #[arg(long)]
        enter: bool,
        /// Prefix a Ctrl-C byte before the text
        #[arg(long)]
        interrupt: bool,
    },
    /// Long-poll until a condition holds (exit | tui-idle)
    Wait {
        id: String,
        #[arg(long = "for")]
        for_cond: String,
        #[arg(long = "timeout-ms", default_value_t = 30_000)]
        timeout_ms: u64,
    },
    /// Create a new session and print its handle
    Create {
        #[arg(long)]
        cwd: Option<String>,
        #[arg(long)]
        worktree: Option<String>,
        /// Session id; a fresh uuid handle is generated when omitted
        #[arg(long)]
        name: Option<String>,
    },
    /// Close (kill) a session
    Close { id: String },
    /// Focus a session in the GUI (applies when a window is attached)
    Switch { id: String },
    /// Rename a session's tab title
    Rename {
        id: String,
        #[arg(long)]
        to: String,
    },
    /// Second session sharing the source's cwd and worktree; prints both handles
    Split { id: String },
}

// Every verb takes --cwd so the daemon resolves ops against that directory;
// execution defaults it to the process working directory when omitted.
#[derive(Subcommand)]
pub enum GitAction {
    /// Show status entries by area with a branch/upstream summary
    Status {
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Stage paths
    Stage {
        #[arg(required = true)]
        paths: Vec<String>,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Unstage paths (back to unstaged/untracked)
    Unstage {
        #[arg(required = true)]
        paths: Vec<String>,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Discard changes in tracked paths (--include-untracked also deletes untracked)
    Discard {
        #[arg(required = true)]
        paths: Vec<String>,
        #[arg(long = "include-untracked")]
        include_untracked: bool,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Commit staged changes
    Commit {
        #[arg(short = 'm', long)]
        message: String,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// List local branches, marking the current one
    Branches {
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Check out a branch
    Checkout {
        branch: String,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Show a file's original/modified content pair
    Diff {
        #[arg(long)]
        path: String,
        #[arg(long)]
        staged: bool,
        #[arg(long = "against-head")]
        against_head: bool,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Recent commits newest-first with per-commit stats
    History {
        #[arg(short = 'n', long)]
        limit: Option<u32>,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Ahead/behind and changed files versus a base ref
    Compare {
        base: String,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Fetch all remotes
    Fetch {
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Pull upstream (ff-only unless --merge)
    Pull {
        #[arg(long)]
        merge: bool,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Fast-forward the current branch to upstream
    Ff {
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Push to upstream (--publish sets upstream on first push)
    Push {
        #[arg(long)]
        publish: bool,
        #[arg(long = "force-with-lease")]
        force_with_lease: bool,
        #[arg(long)]
        cwd: Option<String>,
    },
}

pub fn build_root_command() -> clap::Command {
    Cli::command()
}
