//! Standalone audio-input capture for the visualizer — e.g. a system-audio
//! loopback device (BlackHole) so YouTube and anything else playing on the
//! machine can be visualized.
//!
//! It is independent of the playback/monitor path, so there's no echo or
//! feedback: it only *reads* the device, computes a real spectrum, and emits
//! "audio-spectrum" (the same event the visualizer already renders for engine
//! audio). The cpal stream is `!Send` on macOS, so it's created, owned and
//! dropped entirely on the capture thread — only `Send` handles touch app state.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::DeviceTrait;
use rtrb::RingBuffer;
use tauri::{AppHandle, Emitter};

use crate::audio::input::{build_input_stream, find_input_device};
use crate::audio::meters::{compute_spectrum, viz_band_freqs, VIZ_WINDOW};

/// A running capture session. Dropping it stops and joins the thread.
pub struct VizCapture {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Drop for VizCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Start capturing `device` (or the default input) and emitting "audio-spectrum".
pub fn start(device: Option<String>, app: AppHandle) -> Result<VizCapture, String> {
    // Validate the device up front so the command can report a clear error.
    let dev = find_input_device(device.as_deref())?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    // Report setup back so a config/stream failure surfaces to the command
    // instead of the command reporting success while no spectrum ever arrives.
    let (setup_tx, setup_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let join = thread::Builder::new()
        .name("viz-capture".into())
        .spawn(move || {
            let config = match dev.default_input_config() {
                Ok(c) => c,
                Err(e) => {
                    let _ = setup_tx.send(Err(format!("viz capture: bad input config: {e}")));
                    return;
                }
            };
            let rate = config.sample_rate().0 as f32;
            let channels = config.channels() as usize;
            let (prod, mut cons) = RingBuffer::<f32>::new(config.sample_rate().0 as usize);
            // build_input_stream calls play(); it pushes interleaved stereo f32.
            let stream = match build_input_stream(&dev, &config, channels, prod) {
                Ok(s) => s,
                Err(e) => {
                    let _ = setup_tx.send(Err(format!("viz capture: {e}")));
                    return;
                }
            };
            let _ = setup_tx.send(Ok(()));

            let freqs = viz_band_freqs();
            let mut buf: VecDeque<f32> = VecDeque::with_capacity(VIZ_WINDOW * 2);
            while !stop2.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(33));
                // Drain interleaved stereo pairs → mono.
                while let Ok(l) = cons.pop() {
                    let r = cons.pop().unwrap_or(l);
                    buf.push_back((l + r) * 0.5);
                }
                while buf.len() > VIZ_WINDOW {
                    buf.pop_front();
                }
                if buf.len() >= VIZ_WINDOW / 2 {
                    let window: Vec<f32> = buf.iter().copied().collect();
                    let spectrum = compute_spectrum(&window, rate, &freqs);
                    let _ = app.emit("audio-spectrum", spectrum);
                }
            }
            drop(stream);
        })
        .map_err(|e| format!("failed to start viz-capture thread: {e}"))?;

    match setup_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => Ok(VizCapture {
            stop,
            join: Some(join),
        }),
        Ok(Err(e)) => {
            stop.store(true, Ordering::Release);
            let _ = join.join();
            Err(e)
        }
        // Slow start — assume it's coming up; the loop emits once samples flow.
        Err(_) => Ok(VizCapture {
            stop,
            join: Some(join),
        }),
    }
}
