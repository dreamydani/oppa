// Friendly single-word birth names for terminal panes: raw s- ids must never
// reach the UI, so every session gets a human name at spawn.

pub const FRIENDLY_NAMES: &[&str] = &[
    "fox", "wolf", "bear", "hawk", "otter", "raven", "badger", "heron", "mole", "newt",
    "wren", "finch", "bison", "lynx", "seal", "crane", "gecko", "koala", "lemur", "magpie",
    "narwhal", "ocelot", "pika", "quail", "robin", "sparrow", "stoat", "tapir", "vole", "weasel",
    "birch", "cedar", "elm", "fern", "grove", "heath", "ivy", "juniper", "kelp", "larch",
    "moss", "oak", "pine", "reed", "spruce", "thyme", "willow", "yarrow", "amber", "basalt",
    "cinder", "dune", "ember", "flint", "garnet", "harbor", "inlet", "jasper", "knoll", "lagoon",
    "meadow", "onyx", "prairie", "quartz", "ridge", "summit", "tide", "umber", "vista", "brook",
    "comet", "drift", "frost", "glade",
];

// Synthetic titles are raw ids (s-… or the bare session id); the header hides
// them in favor of a friendly name or the cwd basename.
pub fn is_synthetic_title(title: &str, id: &str) -> bool {
    title == id || title.starts_with("s-")
}

fn hash_str(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

// Deterministic per session id (same id re-picks the same word, good for
// restore remaps); first untaken word wins, numeric suffix only when the pool
// is exhausted.
pub fn pick_friendly_name(session_id: &str, is_taken: &dyn Fn(&str) -> bool) -> String {
    let n = FRIENDLY_NAMES.len();
    let start = (hash_str(session_id) % n as u64) as usize;
    for i in 0..n {
        let cand = FRIENDLY_NAMES[(start + i) % n];
        if !is_taken(cand) {
            return cand.to_string();
        }
    }
    let mut k = 2u32;
    loop {
        let cand = format!("{}-{k}", FRIENDLY_NAMES[start]);
        if !is_taken(&cand) {
            return cand;
        }
        k += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn picked_name_is_never_synthetic_or_empty() {
        for id in ["s-1786150000000-1", "s-1", "abc", ""] {
            let name = pick_friendly_name(id, &|_| false);
            assert!(!name.is_empty());
            assert!(!is_synthetic_title(&name, id), "{name} for {id}");
        }
    }

    #[test]
    fn same_id_picks_same_word_for_restore_stability() {
        let a = pick_friendly_name("s-1", &|_| false);
        assert_eq!(a, pick_friendly_name("s-1", &|_| false));
    }

    #[test]
    fn skips_taken_words() {
        let first = pick_friendly_name("s-2", &|_| false);
        let second = pick_friendly_name("s-2", &|c| c == first);
        assert_ne!(first, second);
    }

    #[test]
    fn exhausted_pool_falls_back_to_suffixed_word() {
        let all: HashSet<&str> = FRIENDLY_NAMES.iter().copied().collect();
        let name = pick_friendly_name("s-3", &|c| all.contains(c));
        assert!(name.contains('-'));
        assert!(!all.contains(name.as_str()));
    }

    #[test]
    fn synthetic_detection_covers_id_equal_and_s_prefix() {
        assert!(is_synthetic_title("s-1-2", "other"));
        assert!(is_synthetic_title("s1", "s1"));
        assert!(!is_synthetic_title("fox", "s-1-2"));
        assert!(!is_synthetic_title("oppa", "s-1-2"));
    }

    #[test]
    fn pool_words_are_single_lowercase_tokens() {
        assert!(FRIENDLY_NAMES.len() >= 60);
        let mut seen = HashSet::new();
        for w in FRIENDLY_NAMES {
            assert!(!w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase()));
            assert!(!w.contains('-') && !w.contains(' '), "{w}");
            assert!(seen.insert(*w), "duplicate {w}");
        }
    }
}
