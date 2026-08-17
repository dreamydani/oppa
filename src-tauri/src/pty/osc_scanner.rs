// In-flight OSC 7 and OSC 9;9 directory scanner for PTY output streams.

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

    pub fn scan(&mut self, chunk: &[u8]) -> Option<String> {
        let mut result = None;

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
                        result = Some(parsed);
                    }
                    self.buffer.clear();
                } else if self.buffer.len() > 1024 {
                    // Prevent unbound buffer growth on malformed escape sequences
                    self.in_osc = false;
                    self.buffer.clear();
                }
            }
        }

        result
    }
}

fn parse_osc_payload(payload: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(payload).ok()?;

    if let Some(rest) = s.strip_prefix("7;") {
        let path = rest.strip_prefix("file://")?;
        // Skip hostname: find the first '/' after file://
        let slash_idx = path.find('/')?;
        let raw_path = &path[slash_idx..];
        let decoded = url_decode(raw_path);
        Some(normalize_parsed_path(&decoded))
    } else if let Some(rest) = s.strip_prefix("9;9;") {
        let unquoted = rest.trim_matches('"');
        Some(normalize_parsed_path(unquoted))
    } else {
        None
    }
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
        let cwd = scanner.scan(stream);
        #[cfg(target_os = "windows")]
        assert_eq!(cwd, Some("C:\\Users\\oppa\\repo".to_string()));
        #[cfg(not(target_os = "windows"))]
        assert_eq!(cwd, Some("/C:/Users/oppa/repo".to_string()));
    }

    #[test]
    fn test_osc_scanner_extracts_osc7_with_escaped_spaces() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]7;file://localhost/home/user/my%20project\x1b\\";
        let cwd = scanner.scan(stream);
        #[cfg(target_os = "windows")]
        assert_eq!(cwd, Some("\\home\\user\\my project".to_string()));
        #[cfg(not(target_os = "windows"))]
        assert_eq!(cwd, Some("/home/user/my project".to_string()));
    }

    #[test]
    fn test_osc_scanner_extracts_osc9_9_path() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]9;9;C:\\projects\\oppa\x07";
        let cwd = scanner.scan(stream);
        assert_eq!(cwd, Some("C:\\projects\\oppa".to_string()));
    }

    #[test]
    fn test_osc_scanner_extracts_osc9_9_quoted_path() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]9;9;\"C:\\projects\\oppa\"\x1b\\";
        let cwd = scanner.scan(stream);
        assert_eq!(cwd, Some("C:\\projects\\oppa".to_string()));
    }

    #[test]
    fn test_osc_scanner_handles_chunked_escapes() {
        let mut scanner = OscScanner::new();
        let part1 = b"some random output\x1b]7;file://host";
        let part2 = b"/tmp/worktree\x07and trailing data";
        assert_eq!(scanner.scan(part1), None);
        #[cfg(target_os = "windows")]
        assert_eq!(scanner.scan(part2), Some("\\tmp\\worktree".to_string()));
        #[cfg(not(target_os = "windows"))]
        assert_eq!(scanner.scan(part2), Some("/tmp/worktree".to_string()));
    }

    #[test]
    fn test_osc_scanner_handles_st_chunked_across_boundary() {
        let mut scanner = OscScanner::new();
        let part1 = b"\x1b]7;file://host/var/log\x1b";
        let part2 = b"\\tailing";
        assert_eq!(scanner.scan(part1), None);
        #[cfg(target_os = "windows")]
        assert_eq!(scanner.scan(part2), Some("\\var\\log".to_string()));
        #[cfg(not(target_os = "windows"))]
        assert_eq!(scanner.scan(part2), Some("/var/log".to_string()));
    }

    #[test]
    fn test_osc_scanner_ignores_non_osc_and_other_oscs() {
        let mut scanner = OscScanner::new();
        let stream1 = b"hello world\n";
        let stream2 = b"\x1b]133;A\x07";
        let stream3 = b"\x1b]0;terminal title\x07";
        assert_eq!(scanner.scan(stream1), None);
        assert_eq!(scanner.scan(stream2), None);
        assert_eq!(scanner.scan(stream3), None);
    }

    #[test]
    fn test_osc_scanner_url_decodes_utf8() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]7;file://localhost/home/user/%E4%BD%A0%E5%A5%BD\x07";
        let cwd = scanner.scan(stream);
        #[cfg(target_os = "windows")]
        assert_eq!(cwd, Some("\\home\\user\\你好".to_string()));
        #[cfg(not(target_os = "windows"))]
        assert_eq!(cwd, Some("/home/user/你好".to_string()));
    }

    #[test]
    fn test_osc_scanner_buffer_overflow_resets() {
        let mut scanner = OscScanner::new();
        let mut huge_garbage = vec![b'a'; 1100];
        huge_garbage[0] = 0x1b;
        huge_garbage[1] = b']';
        assert_eq!(scanner.scan(&huge_garbage), None);
        // Ensure scanner can recover on subsequent valid sequence
        let valid = b"\x1b]9;9;C:\\valid\x07";
        assert_eq!(scanner.scan(valid), Some("C:\\valid".to_string()));
    }
}
