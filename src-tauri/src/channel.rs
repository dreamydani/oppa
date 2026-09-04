/// Build channel: `dev` | `stable` | `rc`, baked in at compile time.
///
/// A Developer-OPPA build and a Stable-OPPA build of the same binary must never
/// share per-user state: the data dir, the daemon pipe/socket, and (later) the
/// window title and updater all key off this one value. Resolving it from a
/// compile-time env keeps GUI and headless-daemon processes in lockstep even
/// though they are separate processes spawned from the same binary.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Dev,
    Stable,
    Rc,
}

impl Channel {
    /// Channel this binary was built for. `OPPA_CHANNEL=dev|stable|rc` is
    /// baked in at compile time; unset means Stable, so the current build —
    /// and every existing test — keeps its exact behavior. Unknown values
    /// fail loudly: a silently misread channel would collide with stable's
    /// data dir/pipe.
    pub fn current() -> Channel {
        match option_env!("OPPA_CHANNEL") {
            Some("dev") => Channel::Dev,
            Some("rc") => Channel::Rc,
            Some("stable") | None => Channel::Stable,
            Some(other) => panic!("unsupported OPPA_CHANNEL value: {other} (expected dev|stable|rc)"),
        }
    }

    /// Suffix appended to the app identifier for this channel's data dir.
    /// Stable is the base name (no suffix); dev gets `-dev`, rc gets `-rc`.
    pub fn data_dir_suffix(&self) -> Option<&'static str> {
        match self {
            Channel::Dev => Some("-dev"),
            Channel::Rc => Some("-rc"),
            Channel::Stable => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Channel::Dev => "dev",
            Channel::Stable => "stable",
            Channel::Rc => "rc",
        }
    }

    pub fn is_dev(&self) -> bool {
        matches!(self, Channel::Dev)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_channel_env_resolves_to_stable() {
        // The default matters: building without OPPA_CHANNEL must stay stable,
        // so today's build keeps its data dir, pipe, and behavior.
        match option_env!("OPPA_CHANNEL") {
            None => {
                assert_eq!(Channel::current(), Channel::Stable);
                assert!(!Channel::current().is_dev());
            }
            Some(_) => { /* dev build; covered by current_matches_build_time_channel_env */ }
        }
    }

    #[test]
    fn current_matches_build_time_channel_env() {
        match option_env!("OPPA_CHANNEL") {
            None | Some("stable") => assert_eq!(Channel::current(), Channel::Stable),
            Some("dev") => assert_eq!(Channel::current(), Channel::Dev),
            Some("rc") => assert_eq!(Channel::current(), Channel::Rc),
            Some(other) => panic!("unsupported OPPA_CHANNEL value in this build: {other}"),
        }
    }

    #[test]
    fn data_dir_suffix_is_none_for_stable_and_dev_suffix_for_dev() {
        assert_eq!(Channel::Stable.data_dir_suffix(), None);
        assert_eq!(Channel::Dev.data_dir_suffix(), Some("-dev"));
    }

    #[test]
    fn as_str_returns_expected_names() {
        assert_eq!(Channel::Dev.as_str(), "dev");
        assert_eq!(Channel::Stable.as_str(), "stable");
    }

    #[test]
    fn is_dev_only_true_for_dev() {
        assert!(Channel::Dev.is_dev());
        assert!(!Channel::Stable.is_dev());
        assert!(!Channel::Rc.is_dev());
    }

    #[test]
    fn rc_as_str_is_rc() {
        assert_eq!(Channel::Rc.as_str(), "rc");
    }

    #[test]
    fn rc_data_dir_suffix_is_isolated() {
        // WHY: rc must never share state with stable (data dir, pipe, snapshots).
        assert_eq!(Channel::Rc.data_dir_suffix(), Some("-rc"));
    }
}
