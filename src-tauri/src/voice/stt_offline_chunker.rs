// Bounded offline-decode chunker — 1:1 port of Orca's
// `stt-offline-audio-chunker.ts`. Offline recognizers decode a whole buffer
// per call and native arena allocations scale with buffer length, so audio
// must be decoded in bounded chunks no matter how long dictation runs.
// Cuts land on the quietest ~100 ms window of the last 5 s so they fall on
// inter-word pauses instead of mid-word.

pub const OFFLINE_DECODE_CHUNK_SECONDS: u32 = 30;
const SPLIT_SEARCH_SECONDS: u32 = 5;
const SPLIT_ENERGY_WINDOW_SECONDS_FRACTION: u32 = 10; // 0.1 s at 16 kHz = 1600 samples

pub struct OfflineAudioChunker {
    buffered: Vec<f32>,
    chunk_sample_limit: usize,
    split_search_samples: usize,
    energy_window_samples: usize,
}

impl OfflineAudioChunker {
    pub fn new(sample_rate: u32) -> Self {
        let energy_window = ((sample_rate / SPLIT_ENERGY_WINDOW_SECONDS_FRACTION) as usize).max(1);
        Self {
            buffered: Vec::new(),
            chunk_sample_limit: ((OFFLINE_DECODE_CHUNK_SECONDS * sample_rate) as usize).max(1),
            split_search_samples: (SPLIT_SEARCH_SECONDS * sample_rate) as usize,
            energy_window_samples: energy_window,
        }
    }

    /// Buffers samples, returning any full chunks now ready to decode.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        if samples.is_empty() {
            return Vec::new();
        }
        self.buffered.extend_from_slice(samples);
        let mut ready = Vec::new();
        while self.buffered.len() >= self.chunk_sample_limit {
            let split = self.find_quiet_split_index();
            let tail = self.buffered.split_off(split);
            ready.push(std::mem::replace(&mut self.buffered, tail));
        }
        ready
    }

    /// Remaining buffered audio (below the chunk limit), if any.
    pub fn flush(&mut self) -> Option<Vec<f32>> {
        if self.buffered.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.buffered))
    }

    pub fn buffered_samples(&self) -> usize {
        self.buffered.len()
    }

    fn find_quiet_split_index(&self) -> usize {
        let limit = self.chunk_sample_limit.min(self.buffered.len());
        let window = self.energy_window_samples;
        let search_start = limit.saturating_sub(self.split_search_samples);
        let hop = (window / 2).max(1);
        let mut best_index = limit;
        let mut best_energy = f64::INFINITY;
        let mut start = search_start;
        while start + window <= limit {
            let energy: f64 = self.buffered[start..start + window]
                .iter()
                .map(|&s| (s as f64) * (s as f64))
                .sum();
            if energy < best_energy {
                best_energy = energy;
                best_index = start + window / 2;
            }
            start += hop;
        }
        // Why: the split must consume at least one sample or push() loops forever.
        best_index.max(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 16000;

    fn loud(len: usize) -> Vec<f32> {
        vec![0.5; len]
    }

    #[test]
    fn emits_nothing_below_the_chunk_limit() {
        let mut chunker = OfflineAudioChunker::new(RATE);
        assert!(chunker.push(&loud(1000)).is_empty());
        assert_eq!(chunker.buffered_samples(), 1000);
    }

    #[test]
    fn splits_at_the_quiet_window() {
        let mut chunker = OfflineAudioChunker::new(RATE);
        // 30 s loud, last 5 s silent: the cut must land inside the silence.
        let mut audio = loud(30 * RATE as usize);
        for sample in audio.iter_mut().skip(25 * RATE as usize) {
            *sample = 0.0;
        }
        let ready = chunker.push(&audio);
        assert_eq!(ready.len(), 1);
        let split = ready[0].len();
        assert!(
            (25 * RATE as usize..30 * RATE as usize).contains(&split),
            "split {split} outside the quiet tail"
        );
        // Tail retained for the next chunk.
        assert_eq!(chunker.buffered_samples(), 30 * RATE as usize - split);
    }

    #[test]
    fn hard_splits_loud_audio_at_the_limit() {
        let mut chunker = OfflineAudioChunker::new(RATE);
        let ready = chunker.push(&loud(31 * RATE as usize));
        assert_eq!(ready.len(), 1);
        // Uniform energy ties resolve to the first search window (Orca
        // parity): cut lands inside the last-5 s search range.
        let split = ready[0].len();
        assert!(
            (25 * RATE as usize..=30 * RATE as usize).contains(&split),
            "split {split} outside the search range"
        );
        assert_eq!(chunker.buffered_samples(), 31 * RATE as usize - split);
    }

    #[test]
    fn flush_returns_the_remainder() {
        let mut chunker = OfflineAudioChunker::new(RATE);
        chunker.push(&loud(100));
        assert_eq!(chunker.flush().map(|v| v.len()), Some(100));
        assert!(chunker.flush().is_none());
    }

    #[test]
    fn empty_push_is_a_no_op() {
        let mut chunker = OfflineAudioChunker::new(RATE);
        assert!(chunker.push(&[]).is_empty());
    }
}
