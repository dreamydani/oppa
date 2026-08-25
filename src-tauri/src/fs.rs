use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditorApp {
    pub name: String,
    pub command: String,
}

#[cfg(windows)]
const EXECUTABLE_EXTENSIONS: &[&str] = &[".com", ".exe", ".bat", ".cmd"];

#[cfg(windows)]
const EDITOR_CANDIDATES: &[(&str, &str)] = &[
    ("VS Code", "code"),
    ("Notepad", "notepad"),
    ("Notepad++", "notepad++"),
    ("Sublime Text", "subl"),
    ("Zed", "zed"),
];

#[cfg(target_os = "macos")]
const EDITOR_CANDIDATES: &[(&str, &str)] = &[
    ("VS Code", "code"),
    ("Sublime Text", "subl"),
    ("Zed", "zed"),
];

#[cfg(all(unix, not(target_os = "macos")))]
const EDITOR_CANDIDATES: &[(&str, &str)] = &[
    ("VS Code", "code"),
    ("gedit", "gedit"),
    ("Kate", "kate"),
    ("Sublime Text", "subl"),
    ("Zed", "zed"),
];

fn editor_candidates() -> &'static [(&'static str, &'static str)] {
    EDITOR_CANDIDATES
}

fn find_in_path(command: &str, path_dirs: &[PathBuf]) -> Option<PathBuf> {
    // Windows resolves commands through PATHEXT, so `code` matches code.cmd shims
    let candidates: Vec<String> = if cfg!(windows) {
        EXECUTABLE_EXTENSIONS
            .iter()
            .map(|ext| format!("{command}{ext}"))
            .collect()
    } else {
        vec![command.to_string()]
    };

    for dir in path_dirs {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

#[tauri::command(async)]
pub fn fs_detect_editors() -> Vec<EditorApp> {
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();

    editor_candidates()
        .iter()
        .filter(|(_, command)| find_in_path(command, &path_dirs).is_some())
        .map(|(name, command)| EditorApp {
            name: name.to_string(),
            command: command.to_string(),
        })
        .collect()
}

#[cfg(windows)]
fn build_open_command(app: Option<&str>, path: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("cmd");
    // `start ""` needs the empty title arg so paths with spaces survive intact;
    // CREATE_NO_WINDOW keeps the cmd shell from flashing on screen.
    match app {
        Some(app) => cmd.args(["/C", "start", "", app, path]),
        None => cmd.args(["/C", "start", "", path]),
    };
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(target_os = "macos")]
fn build_open_command(app: Option<&str>, path: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("open");
    match app {
        Some(app) => cmd.args(["-a", app, path]),
        None => cmd.arg(path),
    };
    cmd
}

#[cfg(all(unix, not(target_os = "macos")))]
fn build_open_command(app: Option<&str>, path: &str) -> std::process::Command {
    let program = app.unwrap_or("xdg-open");
    let mut cmd = std::process::Command::new(program);
    cmd.arg(path);
    cmd
}

// app = None delegates to the OS default handler for the file type
#[tauri::command(async)]
pub fn fs_open_with(path: String, app: Option<String>) -> Result<(), String> {
    let mut cmd = build_open_command(app.as_deref(), &path);
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn fs_read_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(&path);
    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let read_dir = fs::read_dir(dir_path).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let metadata = entry.metadata().ok();
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path().to_string_lossy().to_string();
        let is_dir = file_type.is_dir();
        let size = metadata.map(|m| m.len()).unwrap_or(0);

        entries.push(FileEntry {
            name,
            path: full_path,
            is_dir,
            size,
        });
    }

    // Sort directories first, then alphabetical by name (case-insensitive)
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command(async)]
pub fn fs_read_file(path: String) -> Result<String, String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    if !file_path.is_file() {
        return Err(format!("Path is not a file: {}", path));
    }

    fs::read_to_string(file_path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn fs_write_file(path: String, content: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    if let Some(parent) = file_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    fs::write(file_path, content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn fs_create_dir(path: String) -> Result<(), String> {
    let dir_path = Path::new(&path);
    if dir_path.exists() {
        return Err(format!("Path already exists: {}", path));
    }

    fs::create_dir_all(dir_path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn fs_create_file(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    if file_path.exists() {
        return Ok(());
    }
    if let Some(parent) = file_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    fs::write(file_path, "").map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("oppa-fs-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_fs_read_dir_returns_sorted_entries() {
        let dir = temp_dir("sorted");

        File::create(dir.join("b_file.txt")).unwrap();
        File::create(dir.join("a_file.txt")).unwrap();
        fs::create_dir(dir.join("z_folder")).unwrap();
        fs::create_dir(dir.join("a_folder")).unwrap();

        let entries = fs_read_dir(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(entries.len(), 4);
        assert!(entries[0].is_dir && entries[0].name == "a_folder");
        assert!(entries[1].is_dir && entries[1].name == "z_folder");
        assert!(!entries[2].is_dir && entries[2].name == "a_file.txt");
        assert!(!entries[3].is_dir && entries[3].name == "b_file.txt");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_fs_read_dir_nonexistent_returns_err() {
        let res = fs_read_dir("/nonexistent/path/for/oppa/test".to_string());
        assert!(res.is_err());
    }

    #[test]
    fn test_fs_read_dir_file_as_dir_returns_err() {
        let dir = temp_dir("not_a_dir");
        let file_path = dir.join("some_file.txt");
        File::create(&file_path).unwrap();

        let res = fs_read_dir(file_path.to_string_lossy().to_string());
        assert!(res.is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_fs_read_and_write_file_roundtrip() {
        let dir = temp_dir("rw_test");
        let file_path = dir.join("test.txt");
        let full_path = file_path.to_string_lossy().to_string();

        fs_write_file(full_path.clone(), "hello oppa editor".to_string()).unwrap();
        let content = fs_read_file(full_path).unwrap();
        assert_eq!(content, "hello oppa editor");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_fs_write_file_creates_parent_directories() {
        let dir = temp_dir("parents_test");
        let file_path = dir.join("nested").join("sub").join("file.txt");
        let full_path = file_path.to_string_lossy().to_string();

        fs_write_file(full_path.clone(), "nested content".to_string()).unwrap();
        let content = fs_read_file(full_path).unwrap();
        assert_eq!(content, "nested content");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_fs_create_file_creates_empty_file_and_parents() {
        let dir = temp_dir("create_test");
        let file_path = dir.join("sub").join("new_file.txt");
        let full_path = file_path.to_string_lossy().to_string();

        fs_create_file(full_path.clone()).unwrap();
        assert!(file_path.exists());
        let content = fs_read_file(full_path).unwrap();
        assert_eq!(content, "");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_fs_create_dir_creates_nested_directories() {
        let dir = temp_dir("create_dir_nested");
        let new_dir = dir.join("level1").join("level2");
        let full_path = new_dir.to_string_lossy().to_string();

        let res = fs_create_dir(full_path);
        assert!(res.is_ok());
        assert!(new_dir.is_dir());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_fs_create_dir_already_exists_returns_err() {
        let dir = temp_dir("create_dir_exists");
        let existing = dir.join("existing");
        fs::create_dir(&existing).unwrap();

        let res = fs_create_dir(existing.to_string_lossy().to_string());
        assert!(res.is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_fs_create_dir_file_conflict_returns_err() {
        let dir = temp_dir("create_dir_file_conflict");
        let file_path = dir.join("occupied.txt");
        File::create(&file_path).unwrap();

        let res = fs_create_dir(file_path.to_string_lossy().to_string());
        assert!(res.is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_find_in_path_finds_executable_in_path_dir() {
        let dir = temp_dir("find_in_path_hit");
        // Windows resolves via PATHEXT so the shim name carries an extension
        #[cfg(windows)]
        let exe_name = "code.cmd";
        #[cfg(not(windows))]
        let exe_name = "code";
        File::create(dir.join(exe_name)).unwrap();

        let found = find_in_path("code", &[dir.clone()]);
        assert_eq!(found, Some(dir.join(exe_name)));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_find_in_path_returns_none_when_missing() {
        let dir = temp_dir("find_in_path_miss");

        assert_eq!(find_in_path("definitely-not-installed-oppa", &[dir.clone()]), None);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_editor_candidates_are_well_formed() {
        let candidates = editor_candidates();
        assert!(!candidates.is_empty());
        for (name, command) in candidates {
            assert!(!name.is_empty());
            assert!(!command.is_empty());
        }
    }

#[cfg(windows)]
#[test]
fn test_build_open_with_command_uses_start_launcher() {
    let cmd = build_open_command(Some("code"), "D:\\proj\\file.ts");
    assert_eq!(cmd.get_program().to_string_lossy(), "cmd");
    let args: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    assert_eq!(args, vec!["/C", "start", "", "code", "D:\\proj\\file.ts"]);
}

#[cfg(windows)]
#[test]
fn test_build_open_command_without_app_uses_default_handler() {
    let cmd = build_open_command(None, "D:\\proj\\file.ts");
    let args: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    assert_eq!(args, vec!["/C", "start", "", "D:\\proj\\file.ts"]);
}

#[cfg(target_os = "macos")]
#[test]
fn test_build_open_with_command_uses_open_dash_a() {
    let cmd = build_open_command(Some("TextEdit"), "/tmp/file.txt");
    assert_eq!(cmd.get_program().to_string_lossy(), "open");
    let args: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    assert_eq!(args, vec!["-a", "TextEdit", "/tmp/file.txt"]);
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn test_build_open_with_command_executes_app_directly() {
    let cmd = build_open_command(Some("gedit"), "/tmp/file.txt");
    assert_eq!(cmd.get_program().to_string_lossy(), "gedit");
    assert_eq!(
        cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect::<Vec<_>>(),
        vec!["/tmp/file.txt"]
    );
}

    #[test]
    fn test_fs_create_file_already_exists_returns_ok() {
        let dir = temp_dir("create_exists");
        let file_path = dir.join("existing.txt");
        let full_path = file_path.to_string_lossy().to_string();

        fs_write_file(full_path.clone(), "original content".to_string()).unwrap();
        let res = fs_create_file(full_path.clone());
        assert!(res.is_ok());
        let content = fs_read_file(full_path).unwrap();
        assert_eq!(content, "original content");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_fs_read_file_nonexistent_returns_err() {
        let res = fs_read_file("/nonexistent/path/for/oppa/test.txt".to_string());
        assert!(res.is_err());
    }

    #[test]
    fn test_fs_read_file_directory_returns_err() {
        let dir = temp_dir("read_dir_err");
        let res = fs_read_file(dir.to_string_lossy().to_string());
        assert!(res.is_err());

        std::fs::remove_dir_all(&dir).ok();
    }
}

