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

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    pub fn get_formatted_snapshot(&self) -> String {
        let screen = self.parser.screen();
        let mut result = String::new();

        // 1. Hide cursor during buffer paint
        result.push_str("\x1b[?25l");
        // 2. Clear visible screen and return to home position
        result.push_str("\x1b[2J\x1b[H");

        // 3. Render screen lines
        let (_rows, cols) = screen.size();
        let row_iter = screen.rows_formatted(0, cols);
        let mut first = true;
        for row_bytes in row_iter {
            if !first {
                result.push_str("\r\n");
            }
            first = false;
            result.push_str(&String::from_utf8_lossy(&row_bytes));
        }

        // 4. Restore absolute cursor position (1-indexed)
        let (cursor_row, cursor_col) = screen.cursor_position();
        result.push_str(&format!("\x1b[{};{}H", cursor_row + 1, cursor_col + 1));
        // 5. Restore cursor visibility
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
}
