//! No-install system-audio capture for the visualizer via Apple's
//! ScreenCaptureKit (macOS 13+). Captures the machine's audio output (which
//! includes YouTube's sandboxed embed) and emits the same `audio-spectrum`
//! event the visualizer renders. Needs the one-time Screen-Recording permission;
//! no virtual driver. The SCStream is owned entirely on the capture thread.

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use screencapturekit::prelude::*;
    use tauri::{AppHandle, Emitter};

    use crate::audio::meters::{compute_spectrum, viz_band_freqs, VIZ_WINDOW};

    const RATE: f32 = 48_000.0;

    /// Receives audio sample buffers on Apple's dispatch queue and tees mono
    /// f32 samples into a shared buffer the spectrum loop drains.
    struct AudioSink {
        buf: Arc<Mutex<VecDeque<f32>>>,
    }

    impl SCStreamOutputTrait for AudioSink {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
            if of_type != SCStreamOutputType::Audio {
                return;
            }
            let Some(list) = sample.audio_buffer_list() else {
                return;
            };
            let Some(b) = list.get(0) else {
                return;
            };
            let channels = b.number_channels.max(1) as usize;
            let bytes = b.data();
            let mut g = self.buf.lock().unwrap_or_else(|p| p.into_inner());
            // Float32 PCM, little-endian. Buffer 0 is the left channel when
            // planar; if interleaved, take every channels-th sample.
            for (i, c) in bytes.chunks_exact(4).enumerate() {
                if channels == 1 || i % channels == 0 {
                    g.push_back(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
                }
            }
            while g.len() > VIZ_WINDOW * 2 {
                g.pop_front();
            }
        }
    }

    pub struct ScreenAudio {
        stop: Arc<AtomicBool>,
        join: Option<JoinHandle<()>>,
    }

    impl Drop for ScreenAudio {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(j) = self.join.take() {
                let _ = j.join();
            }
        }
    }

    pub fn start(app: AppHandle) -> Result<ScreenAudio, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        // Setup runs on the capture thread; report its result back so the
        // command can surface a permission error synchronously.
        let (tx, rx) = mpsc::channel::<Result<(), String>>();

        let join = thread::Builder::new()
            .name("screen-audio".into())
            .spawn(move || {
                let buf = Arc::new(Mutex::new(VecDeque::<f32>::with_capacity(VIZ_WINDOW * 2)));
                let setup = (|| -> Result<SCStream, String> {
                    let content = SCShareableContent::get().map_err(|e| {
                        format!(
                            "Screen-Recording permission needed — grant it in System Settings → \
                             Privacy & Security → Screen & System Audio Recording, then reopen \
                             MUSICPAX. ({e:?})"
                        )
                    })?;
                    let displays = content.displays();
                    let display = displays
                        .first()
                        .ok_or("No display available (Screen-Recording permission not granted).")?;
                    let filter = SCContentFilter::create()
                        .with_display(display)
                        .with_excluding_windows(&[])
                        .build();
                    let config = SCStreamConfiguration::new()
                        .with_captures_audio(true)
                        .with_sample_rate(48_000)
                        .with_channel_count(2);
                    let mut stream = SCStream::new(&filter, &config);
                    stream.add_output_handler(
                        AudioSink { buf: buf.clone() },
                        SCStreamOutputType::Audio,
                    );
                    stream
                        .start_capture()
                        .map_err(|e| format!("Could not start system-audio capture: {e:?}"))?;
                    Ok(stream)
                })();

                let stream = match setup {
                    Ok(s) => {
                        let _ = tx.send(Ok(()));
                        s
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        return;
                    }
                };

                let freqs = viz_band_freqs();
                while !stop2.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(33));
                    let window: Vec<f32> = {
                        let g = buf.lock().unwrap_or_else(|p| p.into_inner());
                        if g.len() < VIZ_WINDOW / 2 {
                            continue;
                        }
                        g.iter().rev().take(VIZ_WINDOW).rev().copied().collect()
                    };
                    let spectrum = compute_spectrum(&window, RATE, &freqs);
                    let _ = app.emit("audio-spectrum", spectrum);
                }
                let _ = stream.stop_capture();
            })
            .map_err(|e| format!("failed to spawn screen-audio thread: {e}"))?;

        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(ScreenAudio {
                stop,
                join: Some(join),
            }),
            Ok(Err(e)) => {
                stop.store(true, Ordering::Release);
                let _ = join.join();
                Err(e)
            }
            // Slow setup — assume it's coming up; the loop emits once samples flow.
            Err(_) => Ok(ScreenAudio {
                stop,
                join: Some(join),
            }),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::AppHandle;

    pub struct ScreenAudio;

    pub fn start(_app: AppHandle) -> Result<ScreenAudio, String> {
        Err("No-install system-audio capture is only available on macOS in this build.".into())
    }
}

pub use imp::{start, ScreenAudio};
