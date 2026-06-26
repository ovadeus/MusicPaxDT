//! Line-in capture: input stream → ring buffer → relay thread (RIAA/tone DSP,
//! resample, record tee) → output ring consumed by the shared output-stream
//! builder in `engine`. Recording writes float32 WAV at the input device's
//! native rate, post-DSP and pre-volume — you archive the corrected signal,
//! not the monitor level.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SizedSample, Stream};
use rtrb::{Consumer, Producer, RingBuffer};
use rubato::{FftFixedIn, Resampler};

use crate::audio::engine::Shared;
use crate::audio::riaa::{DspChain, DspParams};
use crate::audio::sinks::{create_sink, RecordFormat, RecordSink, RecordingStats};

const RESAMPLE_CHUNK: usize = 1024;

// ---------------------------------------------------------------------------
// Recorder thread: drains the record ring to disk between Start/Stop commands.
// ---------------------------------------------------------------------------

pub enum RecCmd {
    Start {
        path: PathBuf,
        format: RecordFormat,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Stop {
        reply: mpsc::Sender<Result<RecordingStats, String>>,
    },
}

fn recorder_loop(
    mut ring: Consumer<f32>,
    rx: mpsc::Receiver<RecCmd>,
    sample_rate: u32,
    shared: Arc<Shared>,
) {
    let mut writer: Option<Box<dyn RecordSink>> = None;
    let mut buf = vec![0f32; 8192];
    loop {
        // Drain whatever the relay has teed off. When idle, discard so the
        // ring never backs up between recordings.
        let mut drained = 0;
        while drained < buf.len() {
            match ring.pop() {
                Ok(s) => {
                    buf[drained] = s;
                    drained += 1;
                }
                Err(_) => break,
            }
        }
        if drained > 0 {
            if let Some(w) = writer.as_mut() {
                if let Err(e) = w.write_samples(&buf[..drained]) {
                    eprintln!("recording write failed: {e}");
                    shared.recording.store(false, Ordering::Release);
                    writer = None;
                }
                shared.rec_frames.store(
                    writer.as_ref().map(|w| w.frames()).unwrap_or(0),
                    Ordering::Relaxed,
                );
            }
        }

        match rx.try_recv() {
            Ok(RecCmd::Start {
                path,
                format,
                reply,
            }) => match create_sink(format, path, sample_rate) {
                Ok(w) => {
                    shared.rec_frames.store(0, Ordering::Relaxed);
                    writer = Some(w);
                    let _ = reply.send(Ok(()));
                }
                Err(e) => {
                    let _ = reply.send(Err(format!("cannot create recording: {e}")));
                }
            },
            Ok(RecCmd::Stop { reply }) => {
                // The relay has already seen recording=false; give it a beat,
                // then drain the tail before finalizing.
                thread::sleep(Duration::from_millis(40));
                if let Some(mut w) = writer.take() {
                    let mut tail = Vec::new();
                    while let Ok(s) = ring.pop() {
                        tail.push(s);
                    }
                    if !tail.is_empty() {
                        let _ = w.write_samples(&tail);
                    }
                    let _ = reply.send(w.finalize().map_err(|e| e.to_string()));
                } else {
                    let _ = reply.send(Err("no recording in progress".into()));
                }
                shared.rec_frames.store(0, Ordering::Relaxed);
            }
            Err(mpsc::TryRecvError::Empty) => {
                if drained == 0 {
                    thread::sleep(Duration::from_millis(10));
                }
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                // Session torn down mid-recording: finalize so the file on
                // disk is still valid, then exit.
                if let Some(w) = writer.take() {
                    let _ = w.finalize();
                }
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Line-in session.
// ---------------------------------------------------------------------------

pub struct LineInSession {
    // Streams drop first so neither side touches the rings during teardown.
    _in_stream: Stream,
    _out_stream: Stream,
    stop: Arc<std::sync::atomic::AtomicBool>,
    relay_join: Option<thread::JoinHandle<()>>,
    rec_tx: Option<mpsc::Sender<RecCmd>>,
    recorder_join: Option<thread::JoinHandle<()>>,
    pub input_device_name: String,
    pub input_rate: u32,
}

impl LineInSession {
    pub fn rec_tx(&self) -> Option<&mpsc::Sender<RecCmd>> {
        self.rec_tx.as_ref()
    }
}

impl Drop for LineInSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(j) = self.relay_join.take() {
            let _ = j.join();
        }
        self.rec_tx = None; // disconnects the recorder, which finalizes any active file
        if let Some(j) = self.recorder_join.take() {
            let _ = j.join();
        }
    }
}

pub fn find_input_device(name: Option<&str>) -> Result<Device, String> {
    let host = cpal::default_host();
    match name {
        Some(wanted) => host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == wanted).unwrap_or(false))
            .ok_or_else(|| format!("input device '{wanted}' not found")),
        None => host
            .default_input_device()
            .ok_or_else(|| "no default input device".to_string()),
    }
}

/// Start capture → DSP → monitor on the given output device.
pub fn start_line_in(
    shared: Arc<Shared>,
    output_device: &Device,
    input_name: Option<&str>,
) -> Result<LineInSession, String> {
    let input_device = find_input_device(input_name)?;
    let input_device_name = input_device.name().map_err(|e| e.to_string())?;
    let in_config = input_device
        .default_input_config()
        .map_err(|e| e.to_string())?;
    let in_rate = in_config.sample_rate().0;
    let in_channels = in_config.channels() as usize;

    let out_config = output_device
        .default_output_config()
        .map_err(|e| e.to_string())?;
    let out_rate = out_config.sample_rate().0;

    // Capture ring: ~0.5 s. Monitor ring: ~0.1 s — this bounds monitor latency.
    let (in_prod, in_cons) = RingBuffer::<f32>::new(in_rate as usize);
    let (out_prod, out_cons) = RingBuffer::<f32>::new(out_rate as usize / 5);
    // Record ring: ~2 s of headroom for disk hiccups.
    let (rec_prod, rec_cons) = RingBuffer::<f32>::new(in_rate as usize * 4);

    shared.base_ms.store(0, Ordering::Relaxed);
    shared.frames_played.store(0, Ordering::Relaxed);
    shared.out_rate.store(out_rate, Ordering::Relaxed);
    shared.duration_ms.store(u64::MAX, Ordering::Relaxed);
    shared.decode_done.store(false, Ordering::Release);
    shared.ended.store(false, Ordering::Release);
    shared.recording.store(false, Ordering::Release);
    shared.rec_frames.store(0, Ordering::Relaxed);

    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let in_stream = build_input_stream(&input_device, &in_config, in_channels, in_prod)?;

    let relay_shared = shared.clone();
    let relay_stop = stop.clone();
    let relay_join = thread::Builder::new()
        .name("line-in-relay".into())
        .spawn(move || {
            relay_loop(
                in_cons,
                out_prod,
                rec_prod,
                relay_stop,
                relay_shared,
                in_rate,
                out_rate,
            )
        })
        .map_err(|e| format!("failed to start relay thread: {e}"))?;

    let (rec_tx, rec_rx) = mpsc::channel();
    let rec_shared = shared.clone();
    let recorder_join = thread::Builder::new()
        .name("line-in-recorder".into())
        .spawn(move || recorder_loop(rec_cons, rec_rx, in_rate, rec_shared))
        .map_err(|e| format!("failed to start recorder thread: {e}"))?;

    let out_stream =
        crate::audio::engine::build_stream(output_device, &out_config, out_cons, shared)?;

    Ok(LineInSession {
        _in_stream: in_stream,
        _out_stream: out_stream,
        stop,
        relay_join: Some(relay_join),
        rec_tx: Some(rec_tx),
        recorder_join: Some(recorder_join),
        input_device_name,
        input_rate: in_rate,
    })
}

fn build_input_stream(
    device: &Device,
    config: &cpal::SupportedStreamConfig,
    channels: usize,
    producer: Producer<f32>,
) -> Result<Stream, String> {
    match config.sample_format() {
        cpal::SampleFormat::F32 => {
            build_input_stream_for::<f32>(device, &config.config(), channels, producer)
        }
        cpal::SampleFormat::I16 => {
            build_input_stream_for::<i16>(device, &config.config(), channels, producer)
        }
        cpal::SampleFormat::U16 => {
            build_input_stream_for::<u16>(device, &config.config(), channels, producer)
        }
        other => Err(format!("unsupported input sample format: {other}")),
    }
}

fn build_input_stream_for<T: SizedSample>(
    device: &Device,
    config: &cpal::StreamConfig,
    channels: usize,
    mut producer: Producer<f32>,
) -> Result<Stream, String>
where
    f32: cpal::FromSample<T>,
{
    let channels = channels.max(1);
    let stream = device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                // Realtime input callback: convert to stereo f32 and push.
                // On overflow drop the newest frames (the relay is stalled
                // anyway; better a glitch than a block).
                for frame in data.chunks(channels) {
                    let l: f32 = frame[0].to_sample();
                    let r: f32 = if channels > 1 {
                        frame[1].to_sample()
                    } else {
                        l
                    };
                    if producer.slots() >= 2 {
                        let _ = producer.push(l);
                        let _ = producer.push(r);
                    }
                }
            },
            |err| eprintln!("input stream error: {err}"),
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

/// Relay: pop captured stereo, apply DSP, tee to the recorder, resample to
/// the output rate, and feed the monitor ring.
fn relay_loop(
    mut input: Consumer<f32>,
    mut output: Producer<f32>,
    mut record: Producer<f32>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    shared: Arc<Shared>,
    in_rate: u32,
    out_rate: u32,
) {
    let mut chain = DspChain::new(in_rate);
    let mut resampler: Option<FftFixedIn<f32>> = if in_rate != out_rate {
        match FftFixedIn::new(in_rate as usize, out_rate as usize, RESAMPLE_CHUNK, 2, 2) {
            Ok(r) => Some(r),
            Err(e) => {
                eprintln!("line-in resampler init failed ({in_rate} → {out_rate}): {e}");
                return;
            }
        }
    } else {
        None
    };

    let mut frame_buf = vec![0f32; 2048];
    let mut acc_l: Vec<f32> = Vec::with_capacity(RESAMPLE_CHUNK * 4);
    let mut acc_r: Vec<f32> = Vec::with_capacity(RESAMPLE_CHUNK * 4);

    while !stop.load(Ordering::Acquire) {
        // Refresh DSP params from the shared atomics.
        let params = DspParams {
            riaa: shared.riaa_on.load(Ordering::Relaxed),
            bass_db: f32::from_bits(shared.bass_db_bits.load(Ordering::Relaxed)),
            treble_db: f32::from_bits(shared.treble_db_bits.load(Ordering::Relaxed)),
        };
        if params != chain.params() {
            chain.set_params(params);
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

        let recording = shared.recording.load(Ordering::Acquire);
        let gain = f32::from_bits(shared.in_gain_bits.load(Ordering::Relaxed));
        for frame in frame_buf[..n].chunks_exact_mut(2) {
            let (mut l, mut r) = (frame[0], frame[1]);
            chain.process(&mut l, &mut r);
            l *= gain;
            r *= gain;
            frame[0] = l;
            frame[1] = r;
            if recording && record.slots() >= 2 {
                let _ = record.push(l);
                let _ = record.push(r);
            }
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
                        Ok(out) => push_monitor(&mut output, &out[0], &out[1], &stop),
                        Err(e) => {
                            eprintln!("line-in resample error: {e}");
                            return;
                        }
                    }
                }
            }
            None => {
                let mut i = 0;
                while i < n {
                    if stop.load(Ordering::Acquire) {
                        return;
                    }
                    if output.slots() >= 2 {
                        let _ = output.push(frame_buf[i]);
                        let _ = output.push(frame_buf[i + 1]);
                        i += 2;
                    } else {
                        thread::sleep(Duration::from_millis(2));
                    }
                }
            }
        }
    }
}

fn push_monitor(
    output: &mut Producer<f32>,
    l: &[f32],
    r: &[f32],
    stop: &std::sync::atomic::AtomicBool,
) {
    let len = l.len().min(r.len());
    let mut i = 0;
    while i < len {
        if stop.load(Ordering::Acquire) {
            return;
        }
        if output.slots() >= 2 {
            let _ = output.push(l[i]);
            let _ = output.push(r[i]);
            i += 1;
        } else {
            thread::sleep(Duration::from_millis(2));
        }
    }
}

pub fn list_input_devices() -> Result<Vec<crate::audio::engine::AudioDeviceInfo>, String> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let mut devices = Vec::new();
    let iter = host.input_devices().map_err(|e| e.to_string())?;
    for device in iter {
        if let Ok(name) = device.name() {
            devices.push(crate::audio::engine::AudioDeviceInfo {
                id: name.clone(),
                is_default: default_name.as_deref() == Some(name.as_str()),
                name,
            });
        }
    }
    Ok(devices)
}
