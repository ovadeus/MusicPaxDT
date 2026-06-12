use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

use crate::error::{AppError, AppResult};

/// Decodes an audio file to interleaved stereo f32 at the file's sample rate.
/// Runs on the decode thread — never on the realtime audio callback.
pub struct AudioFileDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    pub sample_rate: u32,
    pub duration_ms: Option<u64>,
}

impl AudioFileDecoder {
    pub fn open(path: &Path) -> AppResult<Self> {
        let file = File::open(path)?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }

        let format_opts = FormatOptions {
            enable_gapless: true,
            ..Default::default()
        };
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &MetadataOptions::default())
            .map_err(|e| AppError::Decode(format!("unsupported format: {e}")))?;
        let format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| AppError::Decode("no decodable audio track".into()))?;
        let track_id = track.id;
        let codec_params = track.codec_params.clone();

        let sample_rate = codec_params
            .sample_rate
            .ok_or_else(|| AppError::Decode("unknown sample rate".into()))?;
        let duration_ms = codec_params
            .n_frames
            .map(|frames| frames * 1000 / sample_rate as u64);

        let decoder = symphonia::default::get_codecs()
            .make(&codec_params, &DecoderOptions::default())
            .map_err(|e| AppError::Decode(format!("unsupported codec: {e}")))?;

        Ok(Self {
            format,
            decoder,
            track_id,
            sample_rate,
            duration_ms,
        })
    }

    /// Decode the next packet into interleaved stereo. Returns None at end of stream.
    pub fn next_stereo(&mut self) -> AppResult<Option<Vec<f32>>> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    return Ok(None);
                }
                Err(SymError::ResetRequired) => return Ok(None),
                Err(e) => return Err(AppError::Decode(e.to_string())),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            match self.decoder.decode(&packet) {
                Ok(decoded) => {
                    if decoded.frames() == 0 {
                        continue;
                    }
                    let spec = *decoded.spec();
                    let channels = spec.channels.count();
                    let mut buf =
                        SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                    buf.copy_interleaved_ref(decoded);
                    let samples = buf.samples();
                    let frames = samples.len() / channels.max(1);
                    let mut stereo = Vec::with_capacity(frames * 2);
                    match channels {
                        0 => continue,
                        1 => {
                            for s in samples {
                                stereo.push(*s);
                                stereo.push(*s);
                            }
                        }
                        n => {
                            for f in 0..frames {
                                stereo.push(samples[f * n]);
                                stereo.push(samples[f * n + 1]);
                            }
                        }
                    }
                    return Ok(Some(stereo));
                }
                // Skip over corrupt packets instead of aborting playback.
                Err(SymError::DecodeError(_)) => continue,
                Err(e) => return Err(AppError::Decode(e.to_string())),
            }
        }
    }

    pub fn seek_ms(&mut self, ms: u64) -> AppResult<()> {
        self.format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::from(ms as f64 / 1000.0),
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|e| AppError::Decode(format!("seek failed: {e}")))?;
        self.decoder.reset();
        Ok(())
    }
}
