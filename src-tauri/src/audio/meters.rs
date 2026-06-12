use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::audio::engine::{PlaybackState, Shared};

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

/// Pushes engine state to the frontend: "vu-levels" at ~30 Hz while playing,
/// "position" at ~5 Hz, and "playback-state" on every transition. Reads only
/// atomics written by the audio callback — real levels, not faked.
pub fn spawn_emitter(app: AppHandle, shared: Arc<Shared>) {
    let spawned = thread::Builder::new()
        .name("ui-emitter".into())
        .spawn(move || {
            let mut last_state = u8::MAX;
            let mut last_position = u64::MAX;
            let mut levels_were_zero = false;
            let mut tick: u32 = 0;
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

                if state_changed || tick.is_multiple_of(6) {
                    let position_ms = shared.position_ms();
                    if position_ms != last_position {
                        last_position = position_ms;
                        let _ = app.emit("position", PositionPayload { position_ms });
                    }
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("failed to start ui-emitter thread: {e}");
    }
}
