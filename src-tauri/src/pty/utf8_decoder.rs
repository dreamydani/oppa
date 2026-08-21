// Holds leftover incomplete UTF-8 bytes across read chunk boundaries.
#[derive(Debug, Default)]
pub struct Utf8ChunkDecoder {
    residual: Vec<u8>,
}

impl Utf8ChunkDecoder {
    pub fn new() -> Self {
        Self {
            residual: Vec::with_capacity(4),
        }
    }

    // Decodes a chunk into valid UTF-8, buffering incomplete trailing code points.
    pub fn decode(&mut self, chunk: &[u8]) -> String {
        if chunk.is_empty() && self.residual.is_empty() {
            return String::new();
        }

        // Fast path: no pending residual — decode straight from the input
        // slice without copying into a combined buffer.
        if self.residual.is_empty() {
            let mut output = String::with_capacity(chunk.len());
            let mut slice = chunk;
            loop {
                match std::str::from_utf8(slice) {
                    Ok(valid_str) => {
                        output.push_str(valid_str);
                        break;
                    }
                    Err(err) => {
                        let valid_len = err.valid_up_to();
                        if valid_len > 0 {
                            output.push_str(unsafe {
                                std::str::from_utf8_unchecked(&slice[..valid_len])
                            });
                        }
                        match err.error_len() {
                            None => {
                                self.residual.extend_from_slice(&slice[valid_len..]);
                                break;
                            }
                            Some(invalid_len) => {
                                output.push(std::char::REPLACEMENT_CHARACTER);
                                slice = &slice[valid_len + invalid_len..];
                            }
                        }
                    }
                }
            }
            return output;
        }

        let mut buf = std::mem::take(&mut self.residual);
        buf.extend_from_slice(chunk);

        let mut output = String::with_capacity(buf.len());
        let mut slice = &buf[..];

        loop {
            if slice.is_empty() {
                break;
            }

            match std::str::from_utf8(slice) {
                Ok(valid_str) => {
                    output.push_str(valid_str);
                    break;
                }
                Err(err) => {
                    let valid_len = err.valid_up_to();
                    if valid_len > 0 {
                        let valid_str = unsafe { std::str::from_utf8_unchecked(&slice[..valid_len]) };
                        output.push_str(valid_str);
                    }

                    match err.error_len() {
                        None => {
                            // Incomplete multi-byte sequence at chunk end — buffer for next chunk.
                            self.residual.extend_from_slice(&slice[valid_len..]);
                            break;
                        }
                        Some(invalid_len) => {
                            // Definitive invalid UTF-8 byte(s) — emit replacement char and resume.
                            output.push(std::char::REPLACEMENT_CHARACTER);
                            slice = &slice[valid_len + invalid_len..];
                        }
                    }
                }
            }
        }

        output
    }

    // Flushes any pending residual bytes as lossy UTF-8.
    pub fn flush(&mut self) -> String {
        if self.residual.is_empty() {
            String::new()
        } else {
            let remaining = std::mem::take(&mut self.residual);
            String::from_utf8_lossy(&remaining).into_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_split_emoji_across_chunks() {
        let mut decoder = Utf8ChunkDecoder::new();
        let rocket = "🚀"; // 4 bytes: [0xF0, 0x9F, 0x9A, 0x80]
        let bytes = rocket.as_bytes();
        assert_eq!(bytes.len(), 4);

        let chunk1 = &bytes[..2];
        let chunk2 = &bytes[2..];

        let out1 = decoder.decode(chunk1);
        assert_eq!(out1, "");

        let out2 = decoder.decode(chunk2);
        assert_eq!(out2, "🚀");
    }

    #[test]
    fn test_decode_split_cjk_across_chunks() {
        let mut decoder = Utf8ChunkDecoder::new();
        let text = "你好"; // "你" = [0xE4, 0xBD, 0xA0], "好" = [0xE5, 0xA5, 0xBD]
        let bytes = text.as_bytes();
        assert_eq!(bytes.len(), 6);

        // Split "你" across chunk1 (1 byte) and chunk2 (2 bytes)
        // Split "好" across chunk2 (2 bytes) and chunk3 (1 byte)
        let chunk1 = &bytes[0..1]; // [0xE4]
        let chunk2 = &bytes[1..5]; // [0xBD, 0xA0, 0xE5, 0xA5]
        let chunk3 = &bytes[5..6]; // [0xBD]

        let out1 = decoder.decode(chunk1);
        assert_eq!(out1, "");

        let out2 = decoder.decode(chunk2);
        assert_eq!(out2, "你");

        let out3 = decoder.decode(chunk3);
        assert_eq!(out3, "好");
    }

    #[test]
    fn test_decode_ascii_chunks() {
        let mut decoder = Utf8ChunkDecoder::new();
        let out1 = decoder.decode(b"hello ");
        assert_eq!(out1, "hello ");

        let out2 = decoder.decode(b"world\n");
        assert_eq!(out2, "world\n");
    }

    #[test]
    fn test_invalid_bytes_recovery() {
        let mut decoder = Utf8ChunkDecoder::new();
        // 0xFF and 0xFE are invalid UTF-8 bytes
        let out = decoder.decode(&[0xFF, 0xFE, b'a', b'b']);
        assert_eq!(out, "\u{FFFD}\u{FFFD}ab");

        // Next chunk should decode cleanly without leftover invalid state
        let out2 = decoder.decode(b"cd");
        assert_eq!(out2, "cd");
    }

    #[test]
    fn test_multiple_emojis_and_trailing_split() {
        let mut decoder = Utf8ChunkDecoder::new();
        let fire = "🔥"; // [0xF0, 0x9F, 0x94, 0xA5]
        let sparkles = "✨"; // [0xE2, 0x9C, 0xA8]
        let mut combined = Vec::new();
        combined.extend_from_slice(b"status: ");
        combined.extend_from_slice(fire.as_bytes());
        combined.extend_from_slice(b" ");
        combined.extend_from_slice(&sparkles.as_bytes()[..2]); // Incomplete sparkles

        let out1 = decoder.decode(&combined);
        assert_eq!(out1, "status: 🔥 ");

        let out2 = decoder.decode(&sparkles.as_bytes()[2..]);
        assert_eq!(out2, "✨");
    }

    #[test]
    fn test_empty_chunks() {
        let mut decoder = Utf8ChunkDecoder::new();
        assert_eq!(decoder.decode(&[]), "");
        assert_eq!(decoder.decode(b"a"), "a");
        assert_eq!(decoder.decode(&[]), "");
    }

    #[test]
    fn test_flush_residual() {
        let mut decoder = Utf8ChunkDecoder::new();
        let sparkles = "✨";
        let _ = decoder.decode(&sparkles.as_bytes()[..2]);
        let flushed = decoder.flush();
        assert_eq!(flushed, "\u{FFFD}");
        assert_eq!(decoder.flush(), "");
    }

    // Regression guard for the zero-copy fast path: chunked decoding must be
    // byte-identical to single-shot decoding regardless of split points.
    #[test]
    fn test_chunked_decode_equals_single_shot() {
        let text = "ascii ✓ then 日本語 CJK, more 🚀🔥 emojis, é accent, plain end";
        let full = decode_all_chunks(&[text.as_bytes()]);
        assert_eq!(full, text);

        // Deterministic boundary sweep: every possible 1-byte-at-a-time split.
        let bytes = text.as_bytes();
        let mut chunked: Vec<&[u8]> = Vec::new();
        for (i, b) in bytes.iter().enumerate() {
            chunked.push(std::slice::from_ref(b));
            if i == bytes.len() - 1 {
                break;
            }
        }
        assert_eq!(decode_all_chunks(&chunked), text);
    }

    fn decode_all_chunks(chunks: &[&[u8]]) -> String {
        let mut decoder = Utf8ChunkDecoder::new();
        let mut out = String::new();
        for chunk in chunks {
            out.push_str(&decoder.decode(chunk));
        }
        out.push_str(&decoder.flush());
        out
    }
}
