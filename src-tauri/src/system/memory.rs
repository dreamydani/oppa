use crate::pty::manager::PtyManager;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, System};
use tauri::State;

// Orca parity: shared pages can appear in more than one subtree, so summed
// totals may exceed host total. The UI labels the chip Σ RSS for honesty.

#[derive(Debug, Clone, Serialize)]
pub struct HostMemory {
    pub total: u64,
    pub available: u64,
    pub used: u64,
    pub percent: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppMemory {
    pub cpu: Option<f32>,
    pub memory: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionMemory {
    pub session_id: String,
    pub pid: u32,
    pub cpu: Option<f32>,
    pub memory: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemMemorySnapshot {
    pub app: AppMemory,
    pub sessions: Vec<SessionMemory>,
    pub host: HostMemory,
    pub total_memory: u64,
    pub total_cpu: f32,
    pub collected_at_ms: i64,
}

/// Parent index for subtree walks: pid -> parent pid (None at the root).
pub fn build_child_map(parents: &[(u32, Option<u32>)]) -> HashMap<u32, Vec<u32>> {
    let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, parent) in parents {
        if let Some(ppid) = parent {
            map.entry(*ppid).or_default().push(*pid);
        }
        map.entry(*pid).or_default();
    }
    map
}

/// Sum (cpu, rss) over a PID plus all descendants. Unknown PIDs yield None.
pub fn sum_subtree(
    root: u32,
    child_map: &HashMap<u32, Vec<u32>>,
    metrics: &HashMap<u32, (f32, u64)>,
) -> Option<(f32, u64)> {
    if !metrics.contains_key(&root) && !child_map.contains_key(&root) {
        return None;
    }
    let mut visited = HashSet::new();
    let mut stack = vec![root];
    let mut cpu = 0.0f32;
    let mut mem = 0u64;
    let mut found = false;
    while let Some(pid) = stack.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some((c, m)) = metrics.get(&pid) {
            found = true;
            cpu += *c;
            mem += *m;
        }
        if let Some(children) = child_map.get(&pid) {
            stack.extend(children.iter().copied());
        }
    }
    if found { Some((cpu, mem)) } else { None }
}

fn collect_snapshot(session_pids: Vec<(String, u32)>, live_ids: Vec<String>) -> SystemMemorySnapshot {
    let mut sys = System::new_all();
    sys.refresh_all();

    let total = sys.total_memory();
    let available = sys.available_memory();
    let used = total.saturating_sub(available);
    let percent = if total > 0 {
        used as f32 / total as f32 * 100.0
    } else {
        0.0
    };

    let mut metrics: HashMap<u32, (f32, u64)> = HashMap::new();
    let mut parents: Vec<(u32, Option<u32>)> = Vec::new();
    for (pid, proc_) in sys.processes() {
        let id = pid.as_u32();
        metrics.insert(id, (proc_.cpu_usage(), proc_.memory()));
        parents.push((id, proc_.parent().map(Pid::as_u32)));
    }
    let child_map = build_child_map(&parents);

    let pid_by_id: HashMap<&str, u32> =
        session_pids.iter().map(|(id, pid)| (id.as_str(), *pid)).collect();

    let app_sum = sum_subtree(std::process::id(), &child_map, &metrics);
    let app = AppMemory {
        cpu: app_sum.map(|(c, _)| c),
        memory: app_sum.map(|(_, m)| m),
    };

    // Union of daemon live ids + cached pids so warm-restored sessions still
    // render a row (with null metrics → "—") instead of vanishing.
    let mut ids: Vec<String> = live_ids;
    for (id, _) in &session_pids {
        if !ids.iter().any(|live| live == id) {
            ids.push(id.clone());
        }
    }
    ids.sort();

    let mut sessions = Vec::with_capacity(ids.len());
    let mut total_memory = app.memory.unwrap_or(0);
    let mut total_cpu = app.cpu.unwrap_or(0.0);
    for id in ids {
        let pid = pid_by_id.get(id.as_str()).copied().unwrap_or(0);
        let sum = if pid > 0 {
            sum_subtree(pid, &child_map, &metrics)
        } else {
            None
        };
        if let Some((c, m)) = sum {
            total_memory += m;
            total_cpu += c;
        }
        sessions.push(SessionMemory {
            session_id: id,
            pid,
            cpu: sum.map(|(c, _)| c),
            memory: sum.map(|(_, m)| m),
        });
    }

    SystemMemorySnapshot {
        app,
        sessions,
        host: HostMemory {
            total,
            available,
            used,
            percent,
        },
        total_memory,
        total_cpu,
        collected_at_ms: chrono::Utc::now().timestamp_millis(),
    }
}

/// Footer Resource Manager snapshot: host + GUI app + per-session subtrees.
#[tauri::command]
pub fn system_memory_snapshot(manager: State<'_, PtyManager>) -> Result<SystemMemorySnapshot, String> {
    let pids = manager.session_pids_snapshot();
    let live = manager.list();
    Ok(collect_snapshot(pids, live))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtree_sums_descendants_once() {
        let parents = vec![(1, None), (2, Some(1)), (3, Some(1)), (4, Some(2))];
        let map = build_child_map(&parents);
        let metrics: HashMap<u32, (f32, u64)> =
            [(1, (1.0, 10)), (2, (2.0, 20)), (3, (3.0, 30)), (4, (4.0, 40))]
                .into_iter()
                .collect();
        assert_eq!(sum_subtree(1, &map, &metrics), Some((10.0, 100)));
        assert_eq!(sum_subtree(2, &map, &metrics), Some((6.0, 60)));
    }

    #[test]
    fn unknown_pid_yields_none() {
        let map = build_child_map(&[(1, None)]);
        let metrics: HashMap<u32, (f32, u64)> = [(1, (1.0, 10))].into_iter().collect();
        assert_eq!(sum_subtree(999, &map, &metrics), None);
    }

    #[test]
    fn snapshot_serializes_snake_case() {
        let snap = SystemMemorySnapshot {
            app: AppMemory {
                cpu: Some(1.5),
                memory: Some(1024),
            },
            sessions: vec![SessionMemory {
                session_id: "s1".into(),
                pid: 7,
                cpu: None,
                memory: None,
            }],
            host: HostMemory {
                total: 100,
                available: 40,
                used: 60,
                percent: 60.0,
            },
            total_memory: 1024,
            total_cpu: 1.5,
            collected_at_ms: 1,
        };
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"session_id\":\"s1\""));
        assert!(json.contains("\"total_memory\":1024"));
        assert!(json.contains("\"collected_at_ms\":1"));
    }
}
