// 16 kHz guard resampler — port of Orca's `stt-audio-resample.ts` (linear
// interp). The renderer already sends 16 kHz (Slice 3); this covers stray
// rates so the native stream never sees mixed rates (sherpa aborts on that).

pub const STT_SAMPLE_RATE: u32 = 16000;
pub const STT_SAMPLE_RATE_I32: i32 = STT_SAMPLE_RATE as i32;

/// Resample mono f32 to 16 kHz. Returns the input untouched at 16 kHz.
pub fn resample_to_16k(samples: &[f32], from_rate: u32) -> Vec<f32> {
    if from_rate == STT_SAMPLE_RATE || from_rate == 0 || samples.is_empty() {
        return samples.to_vec();
    }
    let out_len = ((samples.len() as u64 * STT_SAMPLE_RATE as u64) / from_rate as u64) as usize;
    if out_len == 0 {
        return Vec::new();
    }
    let step = from_rate as f64 / STT_SAMPLE_RATE as f64;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * step;
            let lo = pos.floor() as usize;
            let hi = (lo + 1).min(samples.len() - 1);
            let frac = (pos - lo as f64) as f32;
            samples[lo] * (1.0 - frac) + samples[hi] * frac
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_at_16k() {
        let samples = vec![0.5; 100];
        let out = resample_to_16k(&samples, 16000);
        assert_eq!(out, samples);
    }

    #[test]
    fn downsamples_48k_to_a_third_with_level_preserved() {
        let out = resample_to_16k(&vec![0.5; 4096], 48000);
        assert_eq!(out.len(), 4096 / 3);
        assert!(out.iter().all(|&s| (s - 0.5).abs() < 1e-5));
    }

    #[test]
    fn interpolates_ramps() {
        let out = resample_to_16k(&[0.0, 1.0, 2.0, 3.0], 32000);
        assert_eq!(out.len(), 2);
        assert!((out[0]).abs() < 1e-5);
        assert!((out[1] - 2.0).abs() < 1e-5);
    }

    #[test]
    fn empty_and_zero_rate_are_safe() {
        assert!(resample_to_16k(&[], 48000).is_empty());
        assert_eq!(resample_to_16k(&[1.0, 2.0], 0), vec![1.0, 2.0]);
    }
}
