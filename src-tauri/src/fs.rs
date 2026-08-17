use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
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
}
