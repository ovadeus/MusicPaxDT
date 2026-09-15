//! Talk-over mic: a DJ's voice mixed over the music, for the speakers and
//! the broadcast, with the music ducked while they talk.
//!
//! Shape: a cpal input stream captures the mic into a ring; this module's
//! relay thread (ordinary, not realtime) drains it, resamples to the output
//! rate, applies gain, measures level, decides whether someone is talking,
//! and pushes frames into the *current output stream's* mic ring. That ring
//! is the mirror image of the broadcast tee: the realtime output callback
//! owns its Consumer (lock-free, as the engine requires) and the relay takes
//! the Producer under a mutex — which is fine, because the relay isn't
//! realtime. Rebuilding the output stream per track swaps rings, exactly as
//! the tee does, so the mic survives track changes.
//!
//! Between tracks the engine keeps a silent output stream alive while the mic
//! is on (see `AudioHost::ensure_mic_keepalive`), so a voice reaches the
//! broadcast even when nothing is playing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use cpal::traits::DeviceTrait;
use cpal::Stream;
use rtrb::{Consumer, RingBuffer};
use rubato::{FftFixedIn, Resampler};
use serde::Serialize;

use crate::audio::engine::Shared;
use crate::audio::input::{build_input_stream, find_input_device};
use crate::state::lock_unpoisoned;

/// `Shared::mic_mode` values.
pub const MODE_OPEN: u8 = 1;
/// Push-to-talk: the mic is open only while the key/button is held.
pub const MODE_PTT: u8 = 2;

const RESAMPLE_CHUNK: usize = 1024;

/// What the UI needs to show: whether the mic is running, whether it is
/// currently open, whether ducking is engaged, and a level for the meter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicStatus {
    pub on: bool,
    pub mode: String,
    pub open: bool,
    pub talking: bool,
    /// Post-gain peak of the last chunk, linear 0..1 (the meter converts to dB).
    pub level: f32,
    pub input_device: Option<String>,
    pub input_rate: Option<u32>,
}

pub fn mode_name(mode: u8) -> &'static str {
    if mode == MODE_OPEN {
        "open"
    } else {
        "ptt"
    }
}

pub fn mode_from_name(name: &str) -> u8 {
    if name == "open" {
        MODE_OPEN
    } else {
        MODE_PTT
    }
}

pub fn db_to_linear(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Smooths the music's duck gain so it fades down when a voice starts and
/// eases back up when it stops, instead of stepping. One-pole, per sample,
/// with a fast attack (the voice must not be stepped on by a slow fade) and
/// a slow release (gaps between words must not pump the music).
pub struct DuckEnvelope {
    gain: f32,
    attack: f32,
    release: f32,
}

impl DuckEnvelope {
    /// Defaults: 30 ms attack, 700 ms release — radio talk-over timing.
    pub fn new(sample_rate: u32) -> Self {
        Self::with_times(sample_rate, 0.030, 0.700)
    }

    pub fn with_times(sample_rate: u32, attack_s: f32, release_s: f32) -> Self {
        let coeff = |t: f32| 1.0 - (-1.0 / (t * sample_rate.max(1) as f32)).exp();
        Self {
            gain: 1.0,
            attack: coeff(attack_s),
            release: coeff(release_s),
        }
    }

    /// Advance one sample toward `target` (1.0 = no duck, e.g. 0.25 = -12 dB)
    /// and return the gain to apply to this sample.
    #[inline]
    pub fn step(&mut self, target: f32) -> f32 {
        let c = if target < self.gain { self.attack } else { self.release };
        self.gain += (target - self.gain) * c;
        self.gain
    }

    pub fn gain(&self) -> f32 {
        self.gain
    }
}

/// Decides "someone is talking" from chunk RMS: above the threshold opens
/// the gate, and it stays open for a hold time afterwards so the music
/// doesn't creep back up in the gap between two words.
pub struct VoiceGate {
    threshold: f32,
    hold_frames: u32,
    remaining: u32,
}

impl VoiceGate {
    pub fn new(threshold_db: f32, hold_ms: f32, sample_rate: u32) -> Self {
        Self {
            threshold: db_to_linear(threshold_db),
            hold_frames: (hold_ms / 1000.0 * sample_rate as f32) as u32,
            remaining: 0,
        }
    }

    pub fn set_threshold_linear(&mut self, threshold: f32) {
        self.threshold = threshold;
    }

    /// Feed one chunk's RMS (linear) spanning `frames` frames.
    pub fn update(&mut self, rms: f32, frames: u32) -> bool {
        if rms >= self.threshold {
            self.remaining = self.hold_frames;
            true
        } else if self.remaining > 0 {
            self.remaining = self.remaining.saturating_sub(frames);
            true
        } else {
            false
        }
    }
}

/// A running mic: the capture stream and its relay thread. Dropping it stops
/// capture and joins the relay.
pub struct MicSession {
    // The stream drops first so the callback stops producing before the relay
    // (the ring's consumer) is asked to stop.
    _in_stream: Stream,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
    pub input_device_name: String,
    pub input_rate: u32,
}

impl Drop for MicSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Start capturing `input_name` (None = the default input device).
pub fn start(shared: Arc<Shared>, input_name: Option<&str>) -> Result<MicSession, String> {
    let device = find_input_device(input_name)?;
    let input_device_name = device.name().map_err(|e| e.to_string())?;
    let in_config = device.default_input_config().map_err(|e| e.to_string())?;
    let in_rate = in_config.sample_rate().0;
    let in_channels = in_config.channels() as usize;

    // ~0.5 s of capture headroom; the relay drains it every couple of ms.
    let (in_prod, in_cons) = RingBuffer::<f32>::new(in_rate as usize);
    let in_stream = build_input_stream(&device, &in_config, in_channels, in_prod)?;

    let stop = Arc::new(AtomicBool::new(false));
    let relay_stop = stop.clone();
    let join = thread::Builder::new()
        .name("mic-relay".into())
        .spawn(move || relay_loop(in_cons, relay_stop, shared, in_rate))
        .map_err(|e| format!("failed to start mic relay: {e}"))?;

    Ok(MicSession {
        _in_stream: in_stream,
        stop,
        join: Some(join),
        input_device_name,
        input_rate: in_rate,
    })
}

fn make_resampler(in_rate: u32, out_rate: u32) -> Result<Option<FftFixedIn<f32>>, String> {
    if in_rate == out_rate {
        return Ok(None);
    }
    FftFixedIn::new(in_rate as usize, out_rate as usize, RESAMPLE_CHUNK, 2, 2)
        .map(Some)
        .map_err(|e| format!("mic resampler init failed ({in_rate} → {out_rate}): {e}"))
}

/// Push interleaved stereo frames into the current output stream's mic ring.
/// Drops on overflow: if no output stream is consuming (none exists, or it
/// is being rebuilt), the newest frames are lost rather than the relay
/// stalling — the callback pops the ring dry the moment it exists again.
fn push_out(shared: &Shared, l: &[f32], r: &[f32]) {
    let mut guard = lock_unpoisoned(&shared.mic_prod);
    if let Some(prod) = guard.as_mut() {
        for (a, b) in l.iter().zip(r) {
            if prod.slots() < 2 {
                break;
            }
            let _ = prod.push(*a);
            let _ = prod.push(*b);
        }
    }
}

fn relay_loop(mut input: Consumer<f32>, stop: Arc<AtomicBool>, shared: Arc<Shared>, in_rate: u32) {
    let mut out_rate = shared.out_rate.load(Ordering::Relaxed).max(8000);
    let mut resampler = match make_resampler(in_rate, out_rate) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("mic relay stopped: {e}");
            return;
        }
    };
    // 350 ms hold: long enough to bridge the gap between words.
    let mut gate = VoiceGate::new(-42.0, 350.0, in_rate);

    let mut frame_buf = vec![0f32; 2048];
    let mut acc_l: Vec<f32> = Vec::with_capacity(RESAMPLE_CHUNK * 4);
    let mut acc_r: Vec<f32> = Vec::with_capacity(RESAMPLE_CHUNK * 4);
    let mut out_l: Vec<f32> = Vec::with_capacity(2048);
    let mut out_r: Vec<f32> = Vec::with_capacity(2048);

    while !stop.load(Ordering::Acquire) {
        // The output device (and so its rate) can change under us; follow it.
        let cur_rate = shared.out_rate.load(Ordering::Relaxed).max(8000);
        if cur_rate != out_rate {
            out_rate = cur_rate;
            match make_resampler(in_rate, out_rate) {
                Ok(r) => resampler = r,
                Err(e) => {
                    eprintln!("mic relay stopped: {e}");
                    return;
                }
            }
            acc_l.clear();
            acc_r.clear();
        }

        // Pull a chunk of captured audio (even count = whole frames).
        let mut n = 0;
        while n + 1 < frame_buf.len() && input.slots() >= 2 {
            frame_buf[n] = input.pop().unwrap_or(0.0);
            frame_buf[n + 1] = input.pop().unwrap_or(0.0);
            n += 2;
        }
        if n == 0 {
            thread::sleep(Duration::from_millis(2));
            continue;
        }

        // Gain, then level and talk detection on the post-gain signal — what
        // the listener would hear is what the meter and the gate should see.
        let gain = f32::from_bits(shared.mic_gain_bits.load(Ordering::Relaxed));
        let (mut peak, mut sum) = (0.0f32, 0.0f32);
        for s in frame_buf[..n].iter_mut() {
            *s *= gain;
            let a = s.abs();
            peak = peak.max(a);
            sum += *s * *s;
        }
        let rms = (sum / n as f32).sqrt();
        shared.mic_level_bits.store(peak.to_bits(), Ordering::Relaxed);

        gate.set_threshold_linear(f32::from_bits(
            shared.mic_threshold_bits.load(Ordering::Relaxed),
        ));
        let voice = gate.update(rms, (n / 2) as u32);
        let open = shared.mic_open.load(Ordering::Relaxed);
        let ptt = shared.mic_mode.load(Ordering::Relaxed) == MODE_PTT;
        // Push-to-talk ducks the instant the key is held; an open mic ducks
        // only while a voice is actually present.
        shared
            .mic_voice
            .store(open && (ptt || voice), Ordering::Relaxed);

        // Closed: keep metering (so the user can see the mic is alive) but
        // send nothing. The callback drains whatever is left in its ring.
        if !open {
            continue;
        }

        match resampler.as_mut() {
            Some(rs) => {
                for frame in frame_buf[..n].chunks_exact(2) {
                    acc_l.push(frame[0]);
                    acc_r.push(frame[1]);
                }
                while acc_l.len() >= RESAMPLE_CHUNK {
                    let in_l: Vec<f32> = acc_l.drain(..RESAMPLE_CHUNK).collect();
                    let in_r: Vec<f32> = acc_r.drain(..RESAMPLE_CHUNK).collect();
                    match rs.process(&[in_l, in_r], None) {
                        Ok(out) => push_out(&shared, &out[0], &out[1]),
                        Err(e) => {
                            eprintln!("mic relay stopped: resample error: {e}");
                            return;
                        }
                    }
                }
            }
            None => {
                out_l.clear();
                out_r.clear();
                for frame in frame_buf[..n].chunks_exact(2) {
                    out_l.push(frame[0]);
                    out_r.push(frame[1]);
                }
                push_out(&shared, &out_l, &out_r);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(env: &mut DuckEnvelope, target: f32, samples: usize) -> f32 {
        let mut g = env.gain();
        for _ in 0..samples {
            g = env.step(target);
        }
        g
    }

    /// Attack must be fast (a voice can't wait for a slow fade) and release
    /// slow (the music mustn't pump back up in the gap between words).
    #[test]
    fn duck_attacks_fast_and_releases_slowly() {
        let sr = 48_000;
        let mut env = DuckEnvelope::new(sr);
        // 30 ms of talking: about one attack time constant — well on the way down.
        let g = run(&mut env, 0.25, sr as usize * 30 / 1000);
        assert!(g < 0.55 && g > 0.25, "after 30 ms of attack: {g}");
        // 300 ms: settled at the duck depth.
        let g = run(&mut env, 0.25, sr as usize * 300 / 1000);
        assert!((g - 0.25).abs() < 0.01, "settled: {g}");
        // Voice stops. 30 ms later the music has barely started back up.
        let g = run(&mut env, 1.0, sr as usize * 30 / 1000);
        assert!(g < 0.35, "release must be slow: {g}");
        // 700 ms (one release time constant): most of the way back.
        let g = run(&mut env, 1.0, sr as usize * 670 / 1000);
        assert!(g > 0.6 && g < 0.85, "after one release constant: {g}");
        // Seconds later: fully recovered.
        let g = run(&mut env, 1.0, sr as usize * 3);
        assert!((g - 1.0).abs() < 0.01, "recovered: {g}");
    }

    /// The gate opens on speech, bridges a short silence (a pause between
    /// words) via the hold, and closes once the silence outlasts it.
    #[test]
    fn voice_gate_holds_through_gaps_between_words() {
        let sr = 48_000;
        let mut gate = VoiceGate::new(-42.0, 350.0, sr);
        let loud = db_to_linear(-20.0);
        let quiet = db_to_linear(-60.0);
        assert!(!gate.update(quiet, 480), "silence at start is not talking");
        assert!(gate.update(loud, 480), "speech opens the gate");
        // 200 ms of quiet: inside the hold — still "talking".
        assert!(gate.update(quiet, sr * 200 / 1000));
        // The next chunk begins with 150 ms of hold left, so it still counts:
        // decisions are per chunk (≈20 ms in practice), so the gate over-holds
        // by at most one chunk — never under-holds.
        assert!(gate.update(quiet, sr * 200 / 1000));
        // Hold spent: closed.
        assert!(!gate.update(quiet, sr * 20 / 1000));
        // Speech again reopens it instantly.
        assert!(gate.update(loud, 480));
    }

    #[test]
    fn db_conversion_and_mode_names_round_trip() {
        assert!((db_to_linear(0.0) - 1.0).abs() < 1e-6);
        assert!((db_to_linear(-12.0) - 0.2512).abs() < 1e-3);
        assert!((db_to_linear(-6.0206) - 0.5).abs() < 1e-3);
        assert_eq!(mode_from_name(mode_name(MODE_OPEN)), MODE_OPEN);
        assert_eq!(mode_from_name(mode_name(MODE_PTT)), MODE_PTT);
        assert_eq!(mode_from_name("anything else"), MODE_PTT, "push-to-talk is the safe default");
    }
}
