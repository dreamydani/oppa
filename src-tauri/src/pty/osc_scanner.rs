// In-flight OSC scanner for PTY output streams: cwd tracking (7 / 9;9) and shell-integration command markers (133).

#[derive(Debug, Clone, PartialEq)]
pub enum OscEvent {
    Cwd(String),
    CommandStart(String),
    CommandEnd,
}

pub struct OscScanner {
    buffer: Vec<u8>,
    in_osc: bool,
}

impl Default for OscScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl OscScanner {
    pub fn new() -> Self {
        Self {
            buffer: Vec::with_capacity(512),
            in_osc: false,
        }
    }

    pub fn scan(&mut self, chunk: &[u8]) -> Vec<OscEvent> {
        let mut events = Vec::new();

        for &b in chunk {
            if !self.in_osc {
                if b == 0x1b {
                    self.buffer.clear();
                    self.buffer.push(b);
                } else if self.buffer.len() == 1 && b == b']' {
                    self.buffer.push(b);
                    self.in_osc = true;
                } else {
                    self.buffer.clear();
                }
            } else {
                self.buffer.push(b);
                // Terminators: BEL (\x07) or ST (\x1b\\)
                let is_bel = b == 0x07;
                let is_st = self.buffer.len() >= 2
                    && self.buffer[self.buffer.len() - 2] == 0x1b
                    && b == b'\\';

                if is_bel || is_st {
                    self.in_osc = false;
                    let payload_bytes = if is_st {
                        &self.buffer[2..self.buffer.len() - 2]
                    } else {
                        &self.buffer[2..self.buffer.len() - 1]
                    };

                    if let Some(parsed) = parse_osc_payload(payload_bytes) {
                        events.push(parsed);
                    }
                    self.buffer.clear();
                } else if self.buffer.len() > 1024 {
                    // Prevent unbound buffer growth on malformed escape sequences
                    self.in_osc = false;
                    self.buffer.clear();
                }
            }
        }

        events
    }
}

fn parse_osc_payload(payload: &[u8]) -> Option<OscEvent> {
    let s = std::str::from_utf8(payload).ok()?;

    if let Some(rest) = s.strip_prefix("7;") {
        let path = rest.strip_prefix("file://")?;
        // Skip hostname: find the first '/' after file://
        let slash_idx = path.find('/')?;
        let raw_path = &path[slash_idx..];
        let decoded = url_decode(raw_path);
        Some(OscEvent::Cwd(normalize_parsed_path(&decoded)))
    } else if let Some(rest) = s.strip_prefix("9;9;") {
        let unquoted = rest.trim_matches('"');
        Some(OscEvent::Cwd(normalize_parsed_path(unquoted)))
    } else if let Some(rest) = s.strip_prefix("133;") {
        parse_shell_integration_payload(rest)
    } else {
        None
    }
}

// Final-term markers: C starts a command (cmdline optional), D ends it; A/B are prompt markers we don't track.
fn parse_shell_integration_payload(rest: &str) -> Option<OscEvent> {
    if rest == "C" {
        return Some(OscEvent::CommandStart(String::new()));
    }
    if let Some(cmdline) = rest.strip_prefix("C;") {
        return Some(OscEvent::CommandStart(cmdline.to_string()));
    }
    if rest == "D" || rest.starts_with("D;") {
        return Some(OscEvent::CommandEnd);
    }
    None
}

fn url_decode(input: &str) -> String {
    let mut out = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex_str) = std::str::from_utf8(&bytes[i + 1..=i + 2]) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn normalize_parsed_path(path: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        let bytes = path.as_bytes();
        let trimmed = if path.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b':'
        {
            &path[1..]
        } else {
            path
        };
        trimmed.replace('/', "\\")
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_osc_scanner_extracts_osc7_path() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]7;file://MYHOST/C:/Users/oppa/repo\x07";
        let events = scanner.scan(stream);
        #[cfg(target_os = "windows")]
        assert_eq!(events, vec![OscEvent::Cwd("C:\\Users\\oppa\\repo".to_string())]);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(events, vec![OscEvent::Cwd("/C:/Users/oppa/repo".to_string())]);
    }

    #[test]
    fn test_osc_scanner_extracts_osc7_with_escaped_spaces() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]7;file://localhost/home/user/my%20project\x1b\\";
        let events = scanner.scan(stream);
        #[cfg(target_os = "windows")]
        assert_eq!(events, vec![OscEvent::Cwd("\\home\\user\\my project".to_string())]);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(events, vec![OscEvent::Cwd("/home/user/my project".to_string())]);
    }

    #[test]
    fn test_osc_scanner_extracts_osc9_9_path() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]9;9;C:\\projects\\oppa\x07";
        let events = scanner.scan(stream);
        assert_eq!(events, vec![OscEvent::Cwd("C:\\projects\\oppa".to_string())]);
    }

    #[test]
    fn test_osc_scanner_extracts_osc9_9_quoted_path() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]9;9;\"C:\\projects\\oppa\"\x1b\\";
        let events = scanner.scan(stream);
        assert_eq!(events, vec![OscEvent::Cwd("C:\\projects\\oppa".to_string())]);
    }

    #[test]
    fn test_osc_scanner_handles_chunked_escapes() {
        let mut scanner = OscScanner::new();
        let part1 = b"some random output\x1b]7;file://host";
        let part2 = b"/tmp/worktree\x07and trailing data";
        assert_eq!(scanner.scan(part1), Vec::<OscEvent>::new());
        #[cfg(target_os = "windows")]
        assert_eq!(scanner.scan(part2), vec![OscEvent::Cwd("\\tmp\\worktree".to_string())]);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(scanner.scan(part2), vec![OscEvent::Cwd("/tmp/worktree".to_string())]);
    }

    #[test]
    fn test_osc_scanner_handles_st_chunked_across_boundary() {
        let mut scanner = OscScanner::new();
        let part1 = b"\x1b]7;file://host/var/log\x1b";
        let part2 = b"\\tailing";
        assert_eq!(scanner.scan(part1), Vec::<OscEvent>::new());
        #[cfg(target_os = "windows")]
        assert_eq!(scanner.scan(part2), vec![OscEvent::Cwd("\\var\\log".to_string())]);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(scanner.scan(part2), vec![OscEvent::Cwd("/var/log".to_string())]);
    }

    #[test]
    fn test_osc_scanner_ignores_non_osc_and_other_oscs() {
        let mut scanner = OscScanner::new();
        let stream1 = b"hello world\n";
        let stream3 = b"\x1b]0;terminal title\x07";
        assert_eq!(scanner.scan(stream1), Vec::<OscEvent>::new());
        assert_eq!(scanner.scan(stream3), Vec::<OscEvent>::new());
    }

    #[test]
    fn test_osc_scanner_url_decodes_utf8() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]7;file://localhost/home/user/%E4%BD%A0%E5%A5%BD\x07";
        let events = scanner.scan(stream);
        #[cfg(target_os = "windows")]
        assert_eq!(events, vec![OscEvent::Cwd("\\home\\user\\你好".to_string())]);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(events, vec![OscEvent::Cwd("/home/user/你好".to_string())]);
    }

    #[test]
    fn test_osc_scanner_buffer_overflow_resets() {
        let mut scanner = OscScanner::new();
        let mut huge_garbage = vec![b'a'; 1100];
        huge_garbage[0] = 0x1b;
        huge_garbage[1] = b']';
        assert_eq!(scanner.scan(&huge_garbage), Vec::<OscEvent>::new());
        // Ensure scanner can recover on subsequent valid sequence
        let valid = b"\x1b]9;9;C:\\valid\x07";
        assert_eq!(scanner.scan(valid), vec![OscEvent::Cwd("C:\\valid".to_string())]);
    }

    #[test]
    fn test_osc_scanner_parses_command_start_with_cmdline_bel() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]133;C;git status\x07";
        assert_eq!(
            scanner.scan(stream),
            vec![OscEvent::CommandStart("git status".to_string())]
        );
    }

    #[test]
    fn test_osc_scanner_parses_command_start_with_cmdline_st() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]133;C;cargo build --release\x1b\\";
        assert_eq!(
            scanner.scan(stream),
            vec![OscEvent::CommandStart("cargo build --release".to_string())]
        );
    }

    #[test]
    fn test_osc_scanner_parses_bare_command_start_as_empty_cmdline() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]133;C\x07";
        assert_eq!(
            scanner.scan(stream),
            vec![OscEvent::CommandStart(String::new())]
        );
    }

    #[test]
    fn test_osc_scanner_parses_command_end_without_exit_code() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]133;D\x07";
        assert_eq!(scanner.scan(stream), vec![OscEvent::CommandEnd]);
    }

    #[test]
    fn test_osc_scanner_parses_command_end_with_exit_code() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]133;D;0\x07";
        assert_eq!(scanner.scan(stream), vec![OscEvent::CommandEnd]);
    }

    #[test]
    fn test_osc_scanner_prompt_markers_a_and_b_produce_no_events() {
        let mut scanner = OscScanner::new();
        assert_eq!(scanner.scan(b"\x1b]133;A\x07"), Vec::<OscEvent>::new());
        assert_eq!(scanner.scan(b"\x1b]133;B\x07"), Vec::<OscEvent>::new());
    }

    #[test]
    fn test_osc_scanner_command_start_split_across_chunks() {
        let mut scanner = OscScanner::new();
        let part1 = b"\x1b]133;C;git com";
        let part2 = b"mit -m \"msg\"\x07rest";
        assert_eq!(scanner.scan(part1), Vec::<OscEvent>::new());
        assert_eq!(
            scanner.scan(part2),
            vec![OscEvent::CommandStart("git commit -m \"msg\"".to_string())]
        );
    }

    #[test]
    fn test_osc_scanner_multiple_events_in_one_chunk_in_order() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]133;D;0\x07\x1b]133;C;npm test\x07";
        assert_eq!(
            scanner.scan(stream),
            vec![
                OscEvent::CommandEnd,
                OscEvent::CommandStart("npm test".to_string()),
            ]
        );
    }
}
