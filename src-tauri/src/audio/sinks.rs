//! Recording sinks: one trait, four containers. WAV, AIFF, and MP3 stream to
//! disk as samples arrive; FLAC accumulates and encodes at finalize (flacenc
//! works from a complete buffer), which favors recordings up to roughly a
//! vinyl side in length.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStats {
    pub path: String,
    pub frames: u64,
    pub sample_rate: u32,
    pub duration_ms: u64,
}

/// Lossless PCM bit depths offered in the settings UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PcmBits {
    I16,
    I24,
    F32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordFormat {
    Wav { bits: PcmBits },
    Aiff { bits: PcmBits },
    Flac { bits: PcmBits },
    Mp3 { kbps: u32 },
}

impl RecordFormat {
    /// Build from the persisted settings values; anything unknown falls back
    /// to the float32 WAV default.
    pub fn from_settings(format: &str, bit_depth: &str, mp3_kbps: &str) -> Self {
        let bits = match bit_depth {
            "16" => PcmBits::I16,
            "24" => PcmBits::I24,
            _ => PcmBits::F32,
        };
        match format {
            "aiff" => RecordFormat::Aiff {
                bits: if bits == PcmBits::F32 { PcmBits::I24 } else { bits },
            },
            "flac" => RecordFormat::Flac {
                bits: if bits == PcmBits::F32 { PcmBits::I24 } else { bits },
            },
            "mp3" => RecordFormat::Mp3 {
                kbps: match mp3_kbps {
                    "128" => 128,
                    "192" => 192,
                    "256" => 256,
                    _ => 320,
                },
            },
            _ => RecordFormat::Wav { bits },
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            RecordFormat::Wav { .. } => "wav",
            RecordFormat::Aiff { .. } => "aif",
            RecordFormat::Flac { .. } => "flac",
            RecordFormat::Mp3 { .. } => "mp3",
        }
    }

    pub fn label(&self) -> String {
        let bits = |b: &PcmBits| match b {
            PcmBits::I16 => "16-bit",
            PcmBits::I24 => "24-bit",
            PcmBits::F32 => "32-bit float",
        };
        match self {
            RecordFormat::Wav { bits: b } => format!("WAV {}", bits(b)),
            RecordFormat::Aiff { bits: b } => format!("AIFF {}", bits(b)),
            RecordFormat::Flac { bits: b } => format!("FLAC {}", bits(b)),
            RecordFormat::Mp3 { kbps } => format!("MP3 {kbps} kbps"),
        }
    }

    /// MP3 caps out at 48 kHz; everything else takes any rate.
    pub fn validate_rate(&self, sample_rate: u32) -> Result<(), String> {
        if matches!(self, RecordFormat::Mp3 { .. }) && sample_rate > 48_000 {
            return Err(format!(
                "MP3 supports up to 48 kHz but the input runs at {sample_rate} Hz — choose WAV, AIFF or FLAC for this device"
            ));
        }
        Ok(())
    }
}

/// A destination for interleaved stereo f32 audio.
pub trait RecordSink: Send {
    fn write_samples(&mut self, interleaved: &[f32]) -> std::io::Result<()>;
    fn frames(&self) -> u64;
    fn finalize(self: Box<Self>) -> std::io::Result<RecordingStats>;
}

pub fn create_sink(
    format: RecordFormat,
    path: PathBuf,
    sample_rate: u32,
) -> Result<Box<dyn RecordSink>, String> {
    format.validate_rate(sample_rate)?;
    match format {
        RecordFormat::Wav { bits } => WavSink::create(path, sample_rate, bits)
            .map(|s| Box::new(s) as Box<dyn RecordSink>)
            .map_err(|e| format!("cannot create WAV: {e}")),
        RecordFormat::Aiff { bits } => AiffSink::create(path, sample_rate, bits)
            .map(|s| Box::new(s) as Box<dyn RecordSink>)
            .map_err(|e| format!("cannot create AIFF: {e}")),
        RecordFormat::Flac { bits } => {
            Ok(Box::new(FlacSink::new(path, sample_rate, bits)) as Box<dyn RecordSink>)
        }
        RecordFormat::Mp3 { kbps } => Mp3Sink::create(path, sample_rate, kbps)
            .map(|s| Box::new(s) as Box<dyn RecordSink>),
    }
}

fn stats(path: &std::path::Path, frames: u64, sample_rate: u32) -> RecordingStats {
    RecordingStats {
        path: path.to_string_lossy().into_owned(),
        frames,
        sample_rate,
        duration_ms: frames * 1000 / sample_rate.max(1) as u64,
    }
}

fn clamp_i16(v: f32) -> i16 {
    (v.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

fn clamp_i24(v: f32) -> i32 {
    (v.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32
}

// ---------------------------------------------------------------------------
// WAV (PCM 16/24 or IEEE float32), streaming, sizes patched on finalize.
// ---------------------------------------------------------------------------

pub struct WavSink {
    file: BufWriter<File>,
    path: PathBuf,
    sample_rate: u32,
    bits: PcmBits,
    frames: u64,
}

impl WavSink {
    pub fn create(path: PathBuf, sample_rate: u32, bits: PcmBits) -> std::io::Result<Self> {
        let mut file = BufWriter::new(File::create(&path)?);
        let (fmt_tag, bytes_per_sample): (u16, u32) = match bits {
            PcmBits::I16 => (1, 2),
            PcmBits::I24 => (1, 3),
            PcmBits::F32 => (3, 4),
        };
        let block_align = bytes_per_sample as u16 * 2;
        let mut header = Vec::with_capacity(56);
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&0u32.to_le_bytes()); // patched
        header.extend_from_slice(b"WAVE");
        header.extend_from_slice(b"fmt ");
        header.extend_from_slice(&16u32.to_le_bytes());
        header.extend_from_slice(&fmt_tag.to_le_bytes());
        header.extend_from_slice(&2u16.to_le_bytes());
        header.extend_from_slice(&sample_rate.to_le_bytes());
        header.extend_from_slice(&(sample_rate * bytes_per_sample * 2).to_le_bytes());
        header.extend_from_slice(&block_align.to_le_bytes());
        header.extend_from_slice(&(bytes_per_sample as u16 * 8).to_le_bytes());
        header.extend_from_slice(b"fact");
        header.extend_from_slice(&4u32.to_le_bytes());
        header.extend_from_slice(&0u32.to_le_bytes()); // patched
        header.extend_from_slice(b"data");
        header.extend_from_slice(&0u32.to_le_bytes()); // patched
        file.write_all(&header)?;
        Ok(Self {
            file,
            path,
            sample_rate,
            bits,
            frames: 0,
        })
    }
}

impl RecordSink for WavSink {
    fn write_samples(&mut self, interleaved: &[f32]) -> std::io::Result<()> {
        match self.bits {
            PcmBits::F32 => {
                for s in interleaved {
                    self.file.write_all(&s.to_le_bytes())?;
                }
            }
            PcmBits::I16 => {
                for s in interleaved {
                    self.file.write_all(&clamp_i16(*s).to_le_bytes())?;
                }
            }
            PcmBits::I24 => {
                for s in interleaved {
                    let v = clamp_i24(*s);
                    self.file.write_all(&v.to_le_bytes()[..3])?;
                }
            }
        }
        self.frames += interleaved.len() as u64 / 2;
        Ok(())
    }

    fn frames(&self) -> u64 {
        self.frames
    }

    fn finalize(mut self: Box<Self>) -> std::io::Result<RecordingStats> {
        let bytes_per_sample: u64 = match self.bits {
            PcmBits::I16 => 2,
            PcmBits::I24 => 3,
            PcmBits::F32 => 4,
        };
        let data_len = (self.frames * 2 * bytes_per_sample) as u32;
        self.file.flush()?;
        let file = self.file.get_mut();
        file.seek(SeekFrom::Start(4))?;
        file.write_all(&(48 + data_len).to_le_bytes())?;
        file.seek(SeekFrom::Start(44))?;
        file.write_all(&(self.frames as u32).to_le_bytes())?;
        file.seek(SeekFrom::Start(52))?;
        file.write_all(&data_len.to_le_bytes())?;
        file.flush()?;
        Ok(stats(&self.path, self.frames, self.sample_rate))
    }
}

// ---------------------------------------------------------------------------
// AIFF (PCM 16/24 big-endian), streaming, sizes patched on finalize.
// ---------------------------------------------------------------------------

/// 80-bit IEEE 754 extended float, big-endian — AIFF's sample-rate encoding.
fn extended80(rate: f64) -> [u8; 10] {
    let mut out = [0u8; 10];
    if rate <= 0.0 {
        return out;
    }
    let exponent = rate.log2().floor() as i32;
    let mantissa = rate / (2f64).powi(exponent); // in [1, 2)
    let biased = (16383 + exponent) as u16;
    let mant_bits = (mantissa * (1u64 << 63) as f64) as u64;
    out[0..2].copy_from_slice(&biased.to_be_bytes());
    out[2..10].copy_from_slice(&mant_bits.to_be_bytes());
    out
}

pub struct AiffSink {
    file: BufWriter<File>,
    path: PathBuf,
    sample_rate: u32,
    bits: PcmBits,
    frames: u64,
}

impl AiffSink {
    pub fn create(path: PathBuf, sample_rate: u32, bits: PcmBits) -> std::io::Result<Self> {
        let mut file = BufWriter::new(File::create(&path)?);
        let bit_count: u16 = match bits {
            PcmBits::I16 => 16,
            _ => 24,
        };
        let mut header = Vec::with_capacity(54);
        header.extend_from_slice(b"FORM");
        header.extend_from_slice(&0u32.to_be_bytes()); // patched
        header.extend_from_slice(b"AIFF");
        header.extend_from_slice(b"COMM");
        header.extend_from_slice(&18u32.to_be_bytes());
        header.extend_from_slice(&2u16.to_be_bytes()); // channels
        header.extend_from_slice(&0u32.to_be_bytes()); // frames, patched
        header.extend_from_slice(&bit_count.to_be_bytes());
        header.extend_from_slice(&extended80(sample_rate as f64));
        header.extend_from_slice(b"SSND");
        header.extend_from_slice(&8u32.to_be_bytes()); // patched (data + 8)
        header.extend_from_slice(&0u32.to_be_bytes()); // offset
        header.extend_from_slice(&0u32.to_be_bytes()); // block size
        file.write_all(&header)?;
        Ok(Self {
            file,
            path,
            sample_rate,
            bits,
            frames: 0,
        })
    }
}

impl RecordSink for AiffSink {
    fn write_samples(&mut self, interleaved: &[f32]) -> std::io::Result<()> {
        match self.bits {
            PcmBits::I16 => {
                for s in interleaved {
                    self.file.write_all(&clamp_i16(*s).to_be_bytes())?;
                }
            }
            _ => {
                for s in interleaved {
                    let v = clamp_i24(*s);
                    self.file.write_all(&v.to_be_bytes()[1..4])?;
                }
            }
        }
        self.frames += interleaved.len() as u64 / 2;
        Ok(())
    }

    fn frames(&self) -> u64 {
        self.frames
    }

    fn finalize(mut self: Box<Self>) -> std::io::Result<RecordingStats> {
        let bytes_per_sample: u64 = match self.bits {
            PcmBits::I16 => 2,
            _ => 3,
        };
        let data_len = (self.frames * 2 * bytes_per_sample) as u32;
        self.file.flush()?;
        let file = self.file.get_mut();
        // FORM size: everything after the first 8 bytes.
        file.seek(SeekFrom::Start(4))?;
        file.write_all(&(46 + data_len).to_be_bytes())?;
        // COMM num frames at offset 22.
        file.seek(SeekFrom::Start(22))?;
        file.write_all(&(self.frames as u32).to_be_bytes())?;
        // SSND chunk size at offset 42.
        file.seek(SeekFrom::Start(42))?;
        file.write_all(&(8 + data_len).to_be_bytes())?;
        file.flush()?;
        Ok(stats(&self.path, self.frames, self.sample_rate))
    }
}

// ---------------------------------------------------------------------------
// FLAC — accumulates i32 samples, encodes on finalize (flacenc is buffer-based).
// ---------------------------------------------------------------------------

pub struct FlacSink {
    path: PathBuf,
    sample_rate: u32,
    bits: PcmBits,
    samples: Vec<i32>,
}

impl FlacSink {
    pub fn new(path: PathBuf, sample_rate: u32, bits: PcmBits) -> Self {
        Self {
            path,
            sample_rate,
            bits,
            samples: Vec::new(),
        }
    }
}

/// Cap FLAC's in-RAM sample buffer — flacenc is buffer-based, so the whole
/// recording is held in memory until finalize. ~2 GB of i32 (~87 min of stereo
/// 48 kHz); longer recordings should use WAV/AIFF, which stream to disk. On the
/// cap, write_samples errors and the recorder finalizes what's buffered so far.
const FLAC_MAX_SAMPLES: usize = 500_000_000;

impl RecordSink for FlacSink {
    fn write_samples(&mut self, interleaved: &[f32]) -> std::io::Result<()> {
        if self.samples.len() + interleaved.len() > FLAC_MAX_SAMPLES {
            return Err(std::io::Error::other(
                "FLAC recording hit the ~2 GB in-memory cap; use WAV or AIFF for \
                 multi-hour recordings (they stream directly to disk)",
            ));
        }
        match self.bits {
            PcmBits::I16 => self
                .samples
                .extend(interleaved.iter().map(|s| clamp_i16(*s) as i32)),
            _ => self.samples.extend(interleaved.iter().map(|s| clamp_i24(*s))),
        }
        Ok(())
    }

    fn frames(&self) -> u64 {
        self.samples.len() as u64 / 2
    }

    fn finalize(self: Box<Self>) -> std::io::Result<RecordingStats> {
        use flacenc::component::BitRepr;
        use flacenc::error::Verify;

        let bits_per_sample = match self.bits {
            PcmBits::I16 => 16,
            _ => 24,
        };
        let frames = self.samples.len() as u64 / 2;
        let io_err = |msg: String| std::io::Error::other(msg);

        let config = flacenc::config::Encoder::default()
            .into_verified()
            .map_err(|e| io_err(format!("flac config: {e:?}")))?;
        let source = flacenc::source::MemSource::from_samples(
            &self.samples,
            2,
            bits_per_sample,
            self.sample_rate as usize,
        );
        let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
            .map_err(|e| io_err(format!("flac encode: {e}")))?;
        let mut sink = flacenc::bitsink::ByteSink::new();
        stream
            .write(&mut sink)
            .map_err(|e| io_err(format!("flac write: {e:?}")))?;
        let mut bytes = sink.as_slice().to_vec();
        // flacenc reports the short last block in STREAMINFO min_blocksize,
        // which the spec says to exclude. Strict decoders (symphonia) use
        // min == max to detect fixed-blocksize streams and reject every frame
        // otherwise — patch min to match max.
        if bytes.len() >= 12 && &bytes[0..4] == b"fLaC" {
            let (max_hi, max_lo) = (bytes[10], bytes[11]);
            bytes[8] = max_hi;
            bytes[9] = max_lo;
        }
        std::fs::write(&self.path, &bytes)?;
        Ok(stats(&self.path, frames, self.sample_rate))
    }
}

// ---------------------------------------------------------------------------
// MP3 via LAME (streaming).
// ---------------------------------------------------------------------------

pub struct Mp3Sink {
    file: BufWriter<File>,
    path: PathBuf,
    sample_rate: u32,
    encoder: mp3lame_encoder::Encoder,
    frames: u64,
    out_buf: Vec<u8>,
    left: Vec<f32>,
    right: Vec<f32>,
}

/// Build a configured LAME encoder (stereo, joint-stereo, best quality). Shared
/// by the MP3 file sink and the live broadcaster so both encode identically.
pub fn build_mp3_encoder(sample_rate: u32, kbps: u32) -> Result<mp3lame_encoder::Encoder, String> {
    use mp3lame_encoder::{Bitrate, Builder, Mode, Quality};
    let mut builder = Builder::new().ok_or("LAME init failed")?;
    builder
        .set_sample_rate(sample_rate)
        .map_err(|e| format!("LAME sample rate: {e}"))?;
    builder
        .set_num_channels(2)
        .map_err(|e| format!("LAME channels: {e}"))?;
    let bitrate = match kbps {
        128 => Bitrate::Kbps128,
        192 => Bitrate::Kbps192,
        256 => Bitrate::Kbps256,
        _ => Bitrate::Kbps320,
    };
    builder
        .set_brate(bitrate)
        .map_err(|e| format!("LAME bitrate: {e}"))?;
    builder
        .set_mode(Mode::JointStereo)
        .map_err(|e| format!("LAME mode: {e}"))?;
    builder
        .set_quality(Quality::Best)
        .map_err(|e| format!("LAME quality: {e}"))?;
    builder.build().map_err(|e| format!("LAME build: {e}"))
}

impl Mp3Sink {
    pub fn create(path: PathBuf, sample_rate: u32, kbps: u32) -> Result<Self, String> {
        let encoder = build_mp3_encoder(sample_rate, kbps)?;
        let file = BufWriter::new(File::create(&path).map_err(|e| e.to_string())?);
        Ok(Self {
            file,
            path,
            sample_rate,
            encoder,
            frames: 0,
            out_buf: Vec::new(),
            left: Vec::new(),
            right: Vec::new(),
        })
    }
}

impl RecordSink for Mp3Sink {
    fn write_samples(&mut self, interleaved: &[f32]) -> std::io::Result<()> {
        use mp3lame_encoder::DualPcm;
        self.left.clear();
        self.right.clear();
        for frame in interleaved.chunks_exact(2) {
            self.left.push(frame[0]);
            self.right.push(frame[1]);
        }
        self.out_buf.clear();
        // encode_to_vec writes into spare capacity only — LAME treats a
        // zero-sized output as "trust me" and scribbles, so reserve first.
        self.out_buf
            .reserve(mp3lame_encoder::max_required_buffer_size(self.left.len()));
        self.encoder
            .encode_to_vec(
                DualPcm {
                    left: &self.left,
                    right: &self.right,
                },
                &mut self.out_buf,
            )
            .map_err(|e| std::io::Error::other(format!("mp3 encode: {e}")))?;
        self.file.write_all(&self.out_buf)?;
        self.frames += interleaved.len() as u64 / 2;
        Ok(())
    }

    fn frames(&self) -> u64 {
        self.frames
    }

    fn finalize(mut self: Box<Self>) -> std::io::Result<RecordingStats> {
        use mp3lame_encoder::FlushNoGap;
        self.out_buf.clear();
        self.out_buf.reserve(mp3lame_encoder::max_required_buffer_size(0));
        self.encoder
            .flush_to_vec::<FlushNoGap>(&mut self.out_buf)
            .map_err(|e| std::io::Error::other(format!("mp3 flush: {e}")))?;
        self.file.write_all(&self.out_buf)?;
        self.file.flush()?;
        Ok(stats(&self.path, self.frames, self.sample_rate))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::decode::AudioFileDecoder;

    fn sine_interleaved(rate: u32, secs: f32) -> Vec<f32> {
        let n = (rate as f32 * secs) as usize;
        let mut samples = Vec::with_capacity(n * 2);
        for i in 0..n {
            let v = (2.0 * std::f32::consts::PI * 440.0 * i as f32 / rate as f32).sin() * 0.5;
            samples.push(v);
            samples.push(-v);
        }
        samples
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stack-sink-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    /// Encode a second of sine through the sink, then decode with the
    /// project's own decoder and verify duration and signal level.
    fn roundtrip(format: RecordFormat, name: &str, lossless: bool) {
        let rate = 44_100u32;
        let samples = sine_interleaved(rate, 1.0);
        let mut sink = create_sink(format, temp_path(name), rate).expect("create sink");
        // feed in relay-sized chunks
        for chunk in samples.chunks(2048) {
            sink.write_samples(chunk).expect("write");
        }
        let stats = Box::new(sink).finalize().expect("finalize");
        assert_eq!(stats.frames, samples.len() as u64 / 2);

        let path = PathBuf::from(&stats.path);
        let mut dec = AudioFileDecoder::open(&path).expect("decode");
        assert_eq!(dec.sample_rate, rate);
        let mut total = 0usize;
        let mut sum_sq = 0f64;
        let mut peak = 0f32;
        while let Ok(Some(chunk)) = dec.next_stereo() {
            for s in &chunk {
                sum_sq += (*s as f64) * (*s as f64);
                peak = peak.max(s.abs());
            }
            total += chunk.len() / 2;
        }
        // MP3 pads with codec delay; duration must be within ~60 ms.
        let drift = (total as i64 - (samples.len() / 2) as i64).abs();
        assert!(
            drift < (rate as i64 * 6 / 100),
            "{name}: frame drift {drift} too large"
        );
        let rms = (sum_sq / (total as f64 * 2.0)).sqrt();
        // 0.5-amplitude sine has RMS ≈ 0.3536.
        assert!(
            (rms - 0.3536).abs() < if lossless { 0.01 } else { 0.03 },
            "{name}: rms {rms:.4} off"
        );
        assert!((peak - 0.5).abs() < 0.05, "{name}: peak {peak:.4} off");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn wav_f32_roundtrip() {
        roundtrip(RecordFormat::Wav { bits: PcmBits::F32 }, "t.wav", true);
    }

    #[test]
    fn wav_16_roundtrip() {
        roundtrip(RecordFormat::Wav { bits: PcmBits::I16 }, "t16.wav", true);
    }

    #[test]
    fn wav_24_roundtrip() {
        roundtrip(RecordFormat::Wav { bits: PcmBits::I24 }, "t24.wav", true);
    }

    #[test]
    fn aiff_roundtrip() {
        roundtrip(RecordFormat::Aiff { bits: PcmBits::I24 }, "t.aif", true);
        roundtrip(RecordFormat::Aiff { bits: PcmBits::I16 }, "t16.aif", true);
    }

    #[test]
    fn flac_roundtrip() {
        roundtrip(RecordFormat::Flac { bits: PcmBits::I24 }, "t.flac", true);
        roundtrip(RecordFormat::Flac { bits: PcmBits::I16 }, "t16.flac", true);
    }

    #[test]
    fn mp3_roundtrip() {
        roundtrip(RecordFormat::Mp3 { kbps: 320 }, "t320.mp3", false);
        roundtrip(RecordFormat::Mp3 { kbps: 128 }, "t128.mp3", false);
    }

    #[test]
    fn settings_parse_and_guards() {
        assert_eq!(
            RecordFormat::from_settings("mp3", "24", "192"),
            RecordFormat::Mp3 { kbps: 192 }
        );
        assert_eq!(
            RecordFormat::from_settings("wav", "16", "320"),
            RecordFormat::Wav { bits: PcmBits::I16 }
        );
        // unknown values fall back safely
        assert_eq!(
            RecordFormat::from_settings("bogus", "weird", ""),
            RecordFormat::Wav { bits: PcmBits::F32 }
        );
        // AIFF/FLAC have no float variant
        assert_eq!(
            RecordFormat::from_settings("flac", "32", ""),
            RecordFormat::Flac { bits: PcmBits::I24 }
        );
        // MP3 can't take a 96 kHz input
        assert!(RecordFormat::Mp3 { kbps: 320 }.validate_rate(96_000).is_err());
        assert!(RecordFormat::Mp3 { kbps: 320 }.validate_rate(48_000).is_ok());
        assert_eq!(RecordFormat::Mp3 { kbps: 320 }.label(), "MP3 320 kbps");
        assert_eq!(RecordFormat::Mp3 { kbps: 320 }.extension(), "mp3");
    }
}
