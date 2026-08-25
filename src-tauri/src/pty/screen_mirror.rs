use vt100::Parser;

pub struct ScreenMirror {
    parser: Parser,
    cols: u16,
    rows: u16,
}

impl ScreenMirror {
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        Self {
            parser: Parser::new(rows, cols, scrollback),
            cols,
            rows,
        }
    }

    pub fn process(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        self.parser.set_size(rows, cols);
    }

    #[cfg(test)]
    pub fn cols(&self) -> u16 {
        self.cols
    }

    #[cfg(test)]
    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// Plain viewport text (no ANSI, no scrollback) for ReadScreen.
    pub fn get_text(&self) -> String {
        self.parser.screen().contents()
    }

    pub fn get_formatted_snapshot(&self) -> String {
        let screen = self.parser.screen();
        let mut result = String::new();

        // 1. Hide cursor during buffer paint
        result.push_str("\x1b[?25l");
        // 2. Clear visible screen and return to home position
        result.push_str("\x1b[2J\x1b[H");

        // 3. Determine the last active row (cursor row or last row with non-empty content)
        let (_rows, cols) = screen.size();
        let (cursor_row, cursor_col) = screen.cursor_position();
        let formatted_rows: Vec<Vec<u8>> = screen.rows_formatted(0, cols).collect();
        let plain_rows: Vec<String> = screen.rows(0, cols).collect();

        let mut last_active_row = cursor_row as usize;
        for (i, row_str) in plain_rows.iter().enumerate() {
            if !row_str.trim().is_empty() && i > last_active_row {
                last_active_row = i;
            }
        }

        // 4. Render screen lines up to last active row
        let mut first = true;
        for row_bytes in formatted_rows.iter().take(last_active_row + 1) {
            if !first {
                result.push_str("\r\n");
            }
            first = false;
            result.push_str(&String::from_utf8_lossy(row_bytes));
        }

        // 5. Restore absolute cursor position (1-indexed)
        result.push_str(&format!("\x1b[{};{}H", cursor_row + 1, cursor_col + 1));
        // 6. Restore cursor visibility
        result.push_str("\x1b[?25h");

        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_screen_mirror_renders_text_and_cursor() {
        let mut mirror = ScreenMirror::new(80, 24, 1000);
        mirror.process(b"Hello world\r\nLine 2");
        let snapshot = mirror.get_formatted_snapshot();
        assert!(snapshot.contains("Hello world"));
        assert!(snapshot.contains("Line 2"));
    }

    #[test]
    fn test_screen_mirror_ansi_colors_and_clear() {
        let mut mirror = ScreenMirror::new(80, 24, 1000);
        mirror.process(b"\x1b[32mGreen Text\x1b[0m\r\n");
        let snapshot = mirror.get_formatted_snapshot();
        assert!(snapshot.contains("Green Text"));
    }

    #[test]
    fn test_screen_mirror_resize() {
        let mut mirror = ScreenMirror::new(80, 24, 1000);
        mirror.process(b"Some output");
        mirror.resize(100, 30);
        assert_eq!(mirror.cols(), 100);
        assert_eq!(mirror.rows(), 30);
        let snapshot = mirror.get_formatted_snapshot();
        assert!(snapshot.contains("Some output"));
    }

    #[test]
    fn test_screen_mirror_cursor_positioning() {
        let mut mirror = ScreenMirror::new(80, 24, 1000);
        mirror.process(b"\x1b[5;10HHello");
        let snapshot = mirror.get_formatted_snapshot();
        assert!(snapshot.contains("\x1b[5;15H"));
    }

    #[test]
    fn test_screen_mirror_snapshot_omits_trailing_blank_lines() {
        let mut mirror = ScreenMirror::new(80, 24, 1000);
        mirror.process(b"PS C:\\Users\\danial>\x1b[?25h");
        let snapshot = mirror.get_formatted_snapshot();
        assert!(snapshot.contains("PS C:\\Users\\danial>"));
        assert!(!snapshot.contains("\r\n"));
    }

    #[test]
    fn test_get_text_strips_ansi_colors() {
        let mut mirror = ScreenMirror::new(80, 24, 1000);
        mirror.process(b"\x1b[32mGreen Text\x1b[0m\r\n\x1b[1;31mRed Bold\x1b[0m");
        let text = mirror.get_text();
        assert!(text.contains("Green Text"), "got: {text:?}");
        assert!(text.contains("Red Bold"), "got: {text:?}");
        assert!(!text.contains('\x1b'), "plain text must have no escapes: {text:?}");
    }

    #[test]
    fn test_get_text_is_viewport_only_not_scrollback() {
        let mut mirror = ScreenMirror::new(80, 4, 1000);
        for i in 0..10 {
            mirror.process(format!("scrollback-line-{i:02}\r\n").as_bytes());
        }
        let text = mirror.get_text();
        assert!(text.contains("scrollback-line-09"), "last line visible: {text:?}");
        assert!(
            !text.contains("scrollback-line-00"),
            "scrolled-off lines must stay out of viewport text: {text:?}"
        );
    }
}
