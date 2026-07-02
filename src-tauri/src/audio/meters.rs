use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::audio::engine::{PlaybackState, Shared};
use crate::state::lock_unpoisoned;

/// Number of log-spaced frequency bands the visualizer spectrum reports.
pub const VIZ_BANDS: usize = 64;
/// Analysis window (samples) — ~46 ms at 44.1 kHz; resolves bass to ~20 Hz.
pub const VIZ_WINDOW: usize = 2048;

/// Log-spaced band centre frequencies (≈30 Hz … 16 kHz).
pub fn viz_band_freqs() -> [f32; VIZ_BANDS] {
    let mut f = [0.0f32; VIZ_BANDS];
    let (lo, hi) = (30.0f32, 16_000.0f32);
    for (i, slot) in f.iter_mut().enumerate() {
        *slot = lo * (hi / lo).powf(i as f32 / (VIZ_BANDS - 1) as f32);
    }
    f
}

/// Goertzel magnitude per band over `buf` → 0..1-ish values for the visualizer.
pub fn compute_spectrum(buf: &[f32], sample_rate: f32, freqs: &[f32; VIZ_BANDS]) -> Vec<f32> {
    let n = buf.len() as f32;
    freqs
        .iter()
        .map(|&f| {
            let coeff = 2.0 * (std::f32::consts::TAU * f / sample_rate).cos();
            let (mut s1, mut s2) = (0.0f32, 0.0f32);
            for &x in buf {
                let s0 = x + coeff * s1 - s2;
                s2 = s1;
                s1 = s0;
            }
            let power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
            // Normalize, lift quiet detail a touch, and clamp for the UI.
            (power.max(0.0).sqrt() / (n * 0.5) * 3.0).clamp(0.0, 1.0)
        })
        .collect()
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VuLevels {
    pub peak_l: f32,
    pub peak_r: f32,
    pub rms_l: f32,
    pub rms_r: f32,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct PositionPayload {
    position_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatePayload {
    state: PlaybackState,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingPayload {
    recording: bool,
    recorded_ms: u64,
}

/// Pushes engine state to the frontend: "vu-levels" at ~30 Hz while playing,
/// "position" at ~5 Hz, and "playback-state" on every transition. Reads only
/// atomics written by the audio callback — real levels, not faked.
pub fn spawn_emitter(app: AppHandle, shared: Arc<Shared>) {
    let spawned = thread::Builder::new()
        .name("ui-emitter".into())
        .spawn(move || {
            let mut last_state = u8::MAX;
            let mut last_position = u64::MAX;
            let mut last_recording = false;
            let mut levels_were_zero = false;
            let mut tick: u32 = 0;
            let viz_freqs = viz_band_freqs();
            let mut viz_buf: VecDeque<f32> = VecDeque::with_capacity(VIZ_WINDOW * 2);
            loop {
                thread::sleep(Duration::from_millis(33));
                tick = tick.wrapping_add(1);

                let levels = VuLevels {
                    peak_l: f32::from_bits(shared.peak_l_bits.load(Ordering::Relaxed)),
                    peak_r: f32::from_bits(shared.peak_r_bits.load(Ordering::Relaxed)),
                    rms_l: f32::from_bits(shared.rms_l_bits.load(Ordering::Relaxed)),
                    rms_r: f32::from_bits(shared.rms_r_bits.load(Ordering::Relaxed)),
                };
                let zero = levels.peak_l == 0.0
                    && levels.peak_r == 0.0
                    && levels.rms_l == 0.0
                    && levels.rms_r == 0.0;
                // Keep emitting while there is signal; emit one final zero frame
                // when it goes quiet so the meter falls back to rest.
                if !zero || !levels_were_zero {
                    let _ = app.emit("vu-levels", levels);
                }
                levels_were_zero = zero;

                // Visualizer spectrum: drain the audio tap, keep a rolling window,
                // and emit a real per-band spectrum so OWNED audio is visualized.
                if shared.viz_active.load(Ordering::Relaxed) {
                    if let Some(cons) = lock_unpoisoned(&shared.viz_cons).as_mut() {
                        while let Ok(s) = cons.pop() {
                            viz_buf.push_back(s);
                        }
                    }
                    while viz_buf.len() > VIZ_WINDOW {
                        viz_buf.pop_front();
                    }
                    if viz_buf.len() >= VIZ_WINDOW / 2 {
                        let sr = shared.out_rate.load(Ordering::Relaxed) as f32;
                        let window: Vec<f32> = viz_buf.iter().copied().collect();
                        let spectrum = compute_spectrum(&window, sr, &viz_freqs);
                        let _ = app.emit("audio-spectrum", spectrum);
                    }
                } else if !viz_buf.is_empty() {
                    viz_buf.clear();
                }

                let state = shared.state.load(Ordering::Relaxed);
                let state_changed = state != last_state;
                if state_changed {
                    last_state = state;
                    let _ = app.emit(
                        "playback-state",
                        StatePayload {
                            state: shared.playback_state(),
                        },
                    );
                }

                // A track that ended on its own → tell the UI to advance.
                if shared.ended_signal.swap(false, Ordering::Relaxed) {
                    let _ = app.emit("track-ended", ());
                }

                if state_changed || tick.is_multiple_of(6) {
                    let position_ms = shared.position_ms();
                    if position_ms != last_position {
                        last_position = position_ms;
                        let _ = app.emit("position", PositionPayload { position_ms });
                    }
                }

                let recording = shared.recording.load(Ordering::Acquire);
                if recording != last_recording || (recording && tick.is_multiple_of(8)) {
                    last_recording = recording;
                    let _ = app.emit(
                        "recording-state",
                        RecordingPayload {
                            recording,
                            recorded_ms: shared.recorded_ms(),
                        },
                    );
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("failed to start ui-emitter thread: {e}");
    }
}
