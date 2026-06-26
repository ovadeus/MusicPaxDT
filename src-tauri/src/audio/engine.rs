use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, FromSample, SizedSample, Stream, StreamConfig};
use rtrb::{Consumer, Producer, RingBuffer};
use rubato::{FftFixedIn, Resampler};
use serde::Serialize;

use crate::audio::decode::AudioFileDecoder;
use crate::audio::input::{self, LineInSession, RecCmd};
use crate::audio::riaa::DspParams;
use crate::audio::sinks::{RecordFormat, RecordingStats};
use crate::error::{AppError, AppResult};
use crate::library::model::{Capability, Track};
use crate::state::lock_unpoisoned;

const STATE_STOPPED: u8 = 0;
const STATE_PLAYING: u8 = 1;
const STATE_PAUSED: u8 = 2;
const DURATION_UNKNOWN: u64 = u64::MAX;
const RESAMPLE_CHUNK: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackState {
    Stopped,
    Playing,
    Paused,
}

impl PlaybackState {
    fn from_u8(v: u8) -> Self {
        match v {
            STATE_PLAYING => PlaybackState::Playing,
            STATE_PAUSED => PlaybackState::Paused,
            _ => PlaybackState::Stopped,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub track: Track,
    pub position_ms: u64,
    pub state: PlaybackState,
    pub volume: f32,
}

/// State shared between the realtime audio callback, the audio host thread,
/// the UI event emitter, and command handlers. Atomics only — the audio
/// callback never takes a lock and never allocates.
pub struct Shared {
    pub state: AtomicU8,
    pub volume_bits: AtomicU32,
    /// Frames consumed by the callback since the current session started.
    pub frames_played: AtomicU64,
    /// Position (ms) the current session started at (seek offset).
    pub base_ms: AtomicU64,
    pub out_rate: AtomicU32,
    pub duration_ms: AtomicU64,
    pub decode_done: AtomicBool,
    /// Set by the callback when playback ran past the end of decoded audio.
    pub ended: AtomicBool,
    /// Raised by poll_ended on a NATURAL end (not a user stop) so the UI emitter
    /// can fire a `track-ended` event and the frontend can advance the playlist.
    pub ended_signal: AtomicBool,
    pub peak_l_bits: AtomicU32,
    pub peak_r_bits: AtomicU32,
    pub rms_l_bits: AtomicU32,
    pub rms_r_bits: AtomicU32,
    // Receiver DSP + recording (read by the line-in relay thread).
    pub riaa_on: AtomicBool,
    pub bass_db_bits: AtomicU32,
    pub treble_db_bits: AtomicU32,
    pub recording: AtomicBool,
    pub rec_frames: AtomicU64,
    pub in_rate: AtomicU32,
    /// Line-in software input gain (linear multiplier), applied by the relay
    /// after DSP. Lets a quiet/phono-level source be lifted from inside the app.
    pub in_gain_bits: AtomicU32,
    // Live broadcast tee. The realtime callback pushes post-volume stereo into a
    // per-stream ring when `broadcasting` is set; the broadcast worker drains the
    // CURRENT consumer (swapped in whenever the output stream is rebuilt, e.g. a
    // track change) so going live survives track changes. The callback never
    // touches `bcast_cons` — only its own moved-in Producer — so it stays
    // lock-free.
    pub broadcasting: AtomicBool,
    pub bcast_cons: Mutex<Option<Consumer<f32>>>,
}

impl Shared {
    fn new() -> Self {
        Self {
            state: AtomicU8::new(STATE_STOPPED),
            volume_bits: AtomicU32::new(1.0f32.to_bits()),
            frames_played: AtomicU64::new(0),
            base_ms: AtomicU64::new(0),
            out_rate: AtomicU32::new(44_100),
            duration_ms: AtomicU64::new(DURATION_UNKNOWN),
            decode_done: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            ended_signal: AtomicBool::new(false),
            peak_l_bits: AtomicU32::new(0),
            peak_r_bits: AtomicU32::new(0),
            rms_l_bits: AtomicU32::new(0),
            rms_r_bits: AtomicU32::new(0),
            riaa_on: AtomicBool::new(false),
            bass_db_bits: AtomicU32::new(0.0f32.to_bits()),
            treble_db_bits: AtomicU32::new(0.0f32.to_bits()),
            recording: AtomicBool::new(false),
            rec_frames: AtomicU64::new(0),
            in_rate: AtomicU32::new(44_100),
            in_gain_bits: AtomicU32::new(1.0f32.to_bits()),
            broadcasting: AtomicBool::new(false),
            bcast_cons: Mutex::new(None),
        }
    }

    pub fn dsp_params(&self) -> DspParams {
        DspParams {
            riaa: self.riaa_on.load(Ordering::Relaxed),
            bass_db: f32::from_bits(self.bass_db_bits.load(Ordering::Relaxed)),
            treble_db: f32::from_bits(self.treble_db_bits.load(Ordering::Relaxed)),
        }
    }

    pub fn recorded_ms(&self) -> u64 {
        let rate = self.in_rate.load(Ordering::Relaxed).max(1) as u64;
        self.rec_frames.load(Ordering::Relaxed) * 1000 / rate
    }

    pub fn playback_state(&self) -> PlaybackState {
        PlaybackState::from_u8(self.state.load(Ordering::Relaxed))
    }

    pub fn position_ms(&self) -> u64 {
        let rate = self.out_rate.load(Ordering::Relaxed).max(1) as u64;
        let pos = self.base_ms.load(Ordering::Relaxed)
            + self.frames_played.load(Ordering::Relaxed) * 1000 / rate;
        match self.duration_ms.load(Ordering::Relaxed) {
            DURATION_UNKNOWN => pos,
            d => pos.min(d),
        }
    }

    pub fn volume(&self) -> f32 {
        f32::from_bits(self.volume_bits.load(Ordering::Relaxed))
    }

    /// Line-in software input gain as a linear multiplier (1.0 = unity).
    pub fn input_gain(&self) -> f32 {
        f32::from_bits(self.in_gain_bits.load(Ordering::Relaxed))
    }

    fn zero_meters(&self) {
        self.peak_l_bits.store(0, Ordering::Relaxed);
        self.peak_r_bits.store(0, Ordering::Relaxed);
        self.rms_l_bits.store(0, Ordering::Relaxed);
        self.rms_r_bits.store(0, Ordering::Relaxed);
    }
}

enum Cmd {
    Load {
        path: String,
        reply: mpsc::Sender<Result<Option<u64>, String>>,
    },
    Play {
        reply: mpsc::Sender<Result<(), String>>,
    },
    Pause,
    Stop,
    Seek {
        ms: u64,
        reply: mpsc::Sender<Result<(), String>>,
    },
    SetDevice {
        name: Option<String>,
        reply: mpsc::Sender<Result<(), String>>,
    },
    StartLineIn {
        input: Option<String>,
        /// Replies with (resolved input device name, input sample rate).
        reply: mpsc::Sender<Result<(String, u32), String>>,
    },
    StartRecording {
        path: std::path::PathBuf,
        format: RecordFormat,
        reply: mpsc::Sender<Result<(), String>>,
    },
    StopRecording {
        reply: mpsc::Sender<Result<RecordingStats, String>>,
    },
}

/// Identity of the active line-in source, mirrored for status queries.
#[derive(Debug, Clone)]
pub struct LineInInfo {
    pub source: String,
    pub input_device: String,
    pub input_rate: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub mode: String, // "library" | "lineIn"
    pub source: Option<String>,
    pub input_device: Option<String>,
    pub riaa: bool,
    pub bass_db: f32,
    pub treble_db: f32,
    pub input_gain_db: f32,
    pub recording: bool,
    pub recorded_ms: u64,
    pub state: PlaybackState,
    pub position_ms: u64,
    pub volume: f32,
}

/// Send + Sync handle to the audio engine, safe to store in Tauri state.
/// The cpal stream itself lives on a dedicated host thread (cpal streams are
/// not Send); we talk to it over a channel.
pub struct EngineHandle {
    pub shared: Arc<Shared>,
    tx: mpsc::Sender<Cmd>,
    current: Mutex<Option<Track>>,
    line_in: Mutex<Option<LineInInfo>>,
}

impl EngineHandle {
    pub fn new() -> AppResult<Self> {
        let shared = Arc::new(Shared::new());
        let host_shared = shared.clone();
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("audio-host".into())
            .spawn(move || host_loop(rx, host_shared))
            .map_err(|e| AppError::Audio(format!("failed to start audio host: {e}")))?;
        Ok(Self {
            shared,
            tx,
            current: Mutex::new(None),
            line_in: Mutex::new(None),
        })
    }

    fn send(&self, cmd: Cmd) -> AppResult<()> {
        self.tx
            .send(cmd)
            .map_err(|_| AppError::Audio("audio host is not running".into()))
    }

    fn wait<T>(rx: mpsc::Receiver<Result<T, String>>) -> AppResult<T> {
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|_| AppError::Audio("audio host did not respond".into()))?
            .map_err(AppError::Audio)
    }

    /// THE capability gate: only OWNED tracks may enter the playback engine.
    pub fn load(&self, track: Track) -> AppResult<()> {
        if track.capability != Capability::Owned {
            return Err(AppError::NotOwned {
                capability: track.capability.as_str().to_string(),
            });
        }
        let (reply, rx) = mpsc::channel();
        self.send(Cmd::Load {
            path: track.uri.clone(),
            reply,
        })?;
        let duration = Self::wait(rx)?;
        *lock_unpoisoned(&self.line_in) = None;
        let mut slot = lock_unpoisoned(&self.current);
        let mut track = track;
        if track.duration_ms.is_none() {
            track.duration_ms = duration.map(|d| d as i64);
        }
        *slot = Some(track);
        Ok(())
    }

    /// Switch to a live line-in source (phono/tape/cd/aux). Line-in is OWNED
    /// by definition — it is the user's own signal.
    pub fn start_line_in(&self, source: &str, input: Option<String>) -> AppResult<LineInInfo> {
        let (reply, rx) = mpsc::channel();
        self.send(Cmd::StartLineIn { input, reply })?;
        let (input_device, input_rate) = Self::wait(rx)?;
        let info = LineInInfo {
            source: source.to_string(),
            input_device,
            input_rate,
        };
        *lock_unpoisoned(&self.current) = None;
        *lock_unpoisoned(&self.line_in) = Some(info.clone());
        Ok(info)
    }

    pub fn line_in_info(&self) -> Option<LineInInfo> {
        lock_unpoisoned(&self.line_in).clone()
    }

    pub fn set_dsp(&self, params: DspParams) {
        self.shared.riaa_on.store(params.riaa, Ordering::Relaxed);
        self.shared
            .bass_db_bits
            .store(params.bass_db.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
        self.shared
            .treble_db_bits
            .store(params.treble_db.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
    }

    /// Software input gain for the line-in monitor + recording, 0..40 dB.
    pub fn set_input_gain(&self, db: f32) {
        let lin = 10f32.powf(db.clamp(0.0, 40.0) / 20.0);
        self.shared.in_gain_bits.store(lin.to_bits(), Ordering::Relaxed);
    }

    pub fn start_recording(&self, path: std::path::PathBuf, format: RecordFormat) -> AppResult<()> {
        let (reply, rx) = mpsc::channel();
        self.send(Cmd::StartRecording {
            path,
            format,
            reply,
        })?;
        Self::wait(rx)
    }

    pub fn stop_recording(&self) -> AppResult<RecordingStats> {
        let (reply, rx) = mpsc::channel();
        self.send(Cmd::StopRecording { reply })?;
        Self::wait(rx)
    }

    pub fn status(&self) -> EngineStatus {
        let line_in = self.line_in_info();
        let params = self.shared.dsp_params();
        EngineStatus {
            mode: if line_in.is_some() { "lineIn" } else { "library" }.to_string(),
            source: line_in.as_ref().map(|i| i.source.clone()),
            input_device: line_in.as_ref().map(|i| i.input_device.clone()),
            riaa: params.riaa,
            bass_db: params.bass_db,
            treble_db: params.treble_db,
            input_gain_db: 20.0 * self.shared.input_gain().max(1e-6).log10(),
            recording: self.shared.recording.load(Ordering::Acquire),
            recorded_ms: self.shared.recorded_ms(),
            state: self.shared.playback_state(),
            position_ms: self.shared.position_ms(),
            volume: self.shared.volume(),
        }
    }

    pub fn play(&self) -> AppResult<()> {
        let (reply, rx) = mpsc::channel();
        self.send(Cmd::Play { reply })?;
        Self::wait(rx)
    }

    pub fn pause(&self) -> AppResult<()> {
        self.send(Cmd::Pause)
    }

    pub fn stop(&self) -> AppResult<()> {
        *lock_unpoisoned(&self.line_in) = None;
        self.send(Cmd::Stop)
    }

    pub fn seek(&self, ms: u64) -> AppResult<()> {
        let (reply, rx) = mpsc::channel();
        self.send(Cmd::Seek { ms, reply })?;
        Self::wait(rx)
    }

    pub fn set_device(&self, name: Option<String>) -> AppResult<()> {
        let (reply, rx) = mpsc::channel();
        self.send(Cmd::SetDevice { name, reply })?;
        Self::wait(rx)
    }

    pub fn set_volume(&self, level: f32) {
        let clamped = level.clamp(0.0, 1.0);
        self.shared
            .volume_bits
            .store(clamped.to_bits(), Ordering::Relaxed);
    }

    pub fn now_playing(&self) -> Option<NowPlaying> {
        if lock_unpoisoned(&self.line_in).is_some() {
            return None;
        }
        let track = lock_unpoisoned(&self.current).clone()?;
        Some(NowPlaying {
            track,
            position_ms: self.shared.position_ms(),
            state: self.shared.playback_state(),
            volume: self.shared.volume(),
        })
    }
}

pub fn list_devices() -> AppResult<Vec<AudioDeviceInfo>> {
    let host = cpal::default_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());
    let mut devices = Vec::new();
    let iter = host
        .output_devices()
        .map_err(|e| AppError::Audio(e.to_string()))?;
    for device in iter {
        if let Ok(name) = device.name() {
            devices.push(AudioDeviceInfo {
                id: name.clone(),
                is_default: default_name.as_deref() == Some(name.as_str()),
                name,
            });
        }
    }
    Ok(devices)
}

// ---------------------------------------------------------------------------
// Audio host thread: owns the cpal stream and the decode-session lifecycle.
// ---------------------------------------------------------------------------

struct Session {
    // Field order matters: the stream (consumer) must drop before we ask the
    // decode thread (producer) to stop, so it can't block on a full ring.
    _stream: Stream,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

struct AudioHost {
    shared: Arc<Shared>,
    device_name: Option<String>,
    current_path: Option<String>,
    session: Option<Session>,
    line_in: Option<LineInSession>,
}

fn host_loop(rx: mpsc::Receiver<Cmd>, shared: Arc<Shared>) {
    let mut host = AudioHost {
        shared,
        device_name: None,
        current_path: None,
        session: None,
        line_in: None,
    };
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(cmd) => host.handle(cmd),
            Err(mpsc::RecvTimeoutError::Timeout) => host.poll_ended(),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

impl AudioHost {
    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Load { path, reply } => {
                self.stop_line_in();
                self.current_path = Some(path);
                match self.start_session(0) {
                    Ok(duration) => {
                        self.shared.state.store(STATE_PAUSED, Ordering::Relaxed);
                        let _ = reply.send(Ok(duration));
                    }
                    Err(e) => {
                        self.teardown();
                        self.current_path = None;
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Cmd::Play { reply } => {
                if self.line_in.is_none() && self.session.is_none() {
                    if self.current_path.is_none() {
                        let _ = reply.send(Err("no track loaded".into()));
                        return;
                    }
                    if let Err(e) = self.start_session(0) {
                        self.teardown();
                        let _ = reply.send(Err(e));
                        return;
                    }
                }
                self.shared.state.store(STATE_PLAYING, Ordering::Relaxed);
                let _ = reply.send(Ok(()));
            }
            Cmd::Pause => {
                if self.session.is_some() || self.line_in.is_some() {
                    self.shared.state.store(STATE_PAUSED, Ordering::Relaxed);
                    self.shared.zero_meters();
                }
            }
            Cmd::Stop => self.teardown(),
            Cmd::Seek { ms, reply } => {
                if self.line_in.is_some() {
                    let _ = reply.send(Err("cannot seek a live input".into()));
                    return;
                }
                if self.current_path.is_none() {
                    let _ = reply.send(Err("no track loaded".into()));
                    return;
                }
                let was_playing =
                    self.shared.state.load(Ordering::Relaxed) == STATE_PLAYING;
                match self.start_session(ms) {
                    Ok(_) => {
                        let next = if was_playing { STATE_PLAYING } else { STATE_PAUSED };
                        self.shared.state.store(next, Ordering::Relaxed);
                        let _ = reply.send(Ok(()));
                    }
                    Err(e) => {
                        self.teardown();
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Cmd::SetDevice { name, reply } => {
                if self.line_in.is_some() {
                    if self.shared.recording.load(Ordering::Acquire) {
                        let _ = reply
                            .send(Err("stop the recording before switching devices".into()));
                        return;
                    }
                    self.device_name = name;
                    // Rebuild the line-in chain on the new output device.
                    let input = self
                        .line_in
                        .as_ref()
                        .map(|s| s.input_device_name.clone());
                    let state = self.shared.state.load(Ordering::Relaxed);
                    match self.start_line_in_session(input.as_deref()) {
                        Ok(_) => {
                            self.shared.state.store(state, Ordering::Relaxed);
                            let _ = reply.send(Ok(()));
                        }
                        Err(e) => {
                            self.teardown();
                            let _ = reply.send(Err(e));
                        }
                    }
                    return;
                }
                self.device_name = name;
                if self.session.is_some() {
                    // Rebuild the session on the new device at the current position.
                    let state = self.shared.state.load(Ordering::Relaxed);
                    let pos = self.shared.position_ms();
                    match self.start_session(pos) {
                        Ok(_) => {
                            self.shared.state.store(state, Ordering::Relaxed);
                            let _ = reply.send(Ok(()));
                        }
                        Err(e) => {
                            self.teardown();
                            let _ = reply.send(Err(e));
                        }
                    }
                } else {
                    // Validate the device exists even with nothing playing.
                    let _ = reply.send(self.find_device().map(|_| ()));
                }
            }
            Cmd::StartLineIn { input, reply } => {
                self.session = None;
                match self.start_line_in_session(input.as_deref()) {
                    Ok(info) => {
                        // A receiver input goes live immediately.
                        self.shared.state.store(STATE_PLAYING, Ordering::Relaxed);
                        let _ = reply.send(Ok(info));
                    }
                    Err(e) => {
                        self.teardown();
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Cmd::StartRecording {
                path,
                format,
                reply,
            } => {
                let Some(session) = self.line_in.as_ref() else {
                    let _ = reply.send(Err("select a line-in source before recording".into()));
                    return;
                };
                if self.shared.recording.load(Ordering::Acquire) {
                    let _ = reply.send(Err("already recording".into()));
                    return;
                }
                let Some(tx) = session.rec_tx() else {
                    let _ = reply.send(Err("recorder unavailable".into()));
                    return;
                };
                let (rtx, rrx) = mpsc::channel();
                if tx
                    .send(RecCmd::Start {
                        path,
                        format,
                        reply: rtx,
                    })
                    .is_err()
                {
                    let _ = reply.send(Err("recorder thread is not running".into()));
                    return;
                }
                match rrx.recv_timeout(Duration::from_secs(5)) {
                    Ok(Ok(())) => {
                        self.shared.recording.store(true, Ordering::Release);
                        let _ = reply.send(Ok(()));
                    }
                    Ok(Err(e)) => {
                        let _ = reply.send(Err(e));
                    }
                    Err(_) => {
                        let _ = reply.send(Err("recorder did not respond".into()));
                    }
                }
            }
            Cmd::StopRecording { reply } => {
                self.shared.recording.store(false, Ordering::Release);
                let Some(session) = self.line_in.as_ref() else {
                    let _ = reply.send(Err("no line-in session".into()));
                    return;
                };
                let Some(tx) = session.rec_tx() else {
                    let _ = reply.send(Err("recorder unavailable".into()));
                    return;
                };
                let (rtx, rrx) = mpsc::channel();
                if tx.send(RecCmd::Stop { reply: rtx }).is_err() {
                    let _ = reply.send(Err("recorder thread is not running".into()));
                    return;
                }
                match rrx.recv_timeout(Duration::from_secs(10)) {
                    Ok(result) => {
                        let _ = reply.send(result);
                    }
                    Err(_) => {
                        let _ = reply.send(Err("recorder did not respond".into()));
                    }
                }
            }
        }
    }

    /// (Re)start the line-in chain on the current output device. Leaves the
    /// playback state untouched; callers set it after.
    fn start_line_in_session(&mut self, input: Option<&str>) -> Result<(String, u32), String> {
        self.line_in = None;
        self.session = None;
        let device = self.find_device()?;
        let session = input::start_line_in(self.shared.clone(), &device, input)?;
        let info = (session.input_device_name.clone(), session.input_rate);
        self.shared.in_rate.store(session.input_rate, Ordering::Relaxed);
        self.line_in = Some(session);
        Ok(info)
    }

    fn stop_line_in(&mut self) {
        self.shared.recording.store(false, Ordering::Release);
        self.line_in = None; // Drop finalizes any in-flight recording file.
    }

    /// Natural end of track: tear the session down and report stopped.
    fn poll_ended(&mut self) {
        if self.shared.ended.swap(false, Ordering::Acquire) {
            // Natural end (not a user stop) — flag it for the UI emitter, which
            // turns it into a `track-ended` event so the playlist advances.
            self.shared.ended_signal.store(true, Ordering::Relaxed);
            self.teardown();
        }
    }

    fn teardown(&mut self) {
        self.stop_line_in();
        self.session = None;
        self.shared.state.store(STATE_STOPPED, Ordering::Relaxed);
        self.shared.base_ms.store(0, Ordering::Relaxed);
        self.shared.frames_played.store(0, Ordering::Relaxed);
        self.shared.ended.store(false, Ordering::Relaxed);
        self.shared.zero_meters();
    }

    fn find_device(&self) -> Result<Device, String> {
        let host = cpal::default_host();
        match &self.device_name {
            Some(name) => host
                .output_devices()
                .map_err(|e| e.to_string())?
                .find(|d| d.name().map(|n| &n == name).unwrap_or(false))
                .ok_or_else(|| format!("output device '{name}' not found")),
            None => host
                .default_output_device()
                .ok_or_else(|| "no default output device".to_string()),
        }
    }

    /// (Re)start playback of the current track at `start_ms`. Leaves the
    /// playback state untouched; callers set it after.
    fn start_session(&mut self, start_ms: u64) -> Result<Option<u64>, String> {
        self.session = None; // drop old stream + decode thread first

        let path = self
            .current_path
            .clone()
            .ok_or_else(|| "no track loaded".to_string())?;
        let mut decoder =
            AudioFileDecoder::open(Path::new(&path)).map_err(|e| e.to_string())?;
        let duration = decoder.duration_ms;
        let start = duration.map_or(start_ms, |d| start_ms.min(d));
        if start > 0 {
            decoder.seek_ms(start).map_err(|e| e.to_string())?;
        }

        let device = self.find_device()?;
        let supported = device
            .default_output_config()
            .map_err(|e| e.to_string())?;
        let out_rate = supported.sample_rate().0;

        // ~1 second of interleaved stereo between decode and audio threads.
        let (producer, consumer) = RingBuffer::<f32>::new(out_rate as usize * 2);

        let shared = self.shared.clone();
        shared.base_ms.store(start, Ordering::Relaxed);
        shared.frames_played.store(0, Ordering::Relaxed);
        shared.out_rate.store(out_rate, Ordering::Relaxed);
        shared
            .duration_ms
            .store(duration.unwrap_or(DURATION_UNKNOWN), Ordering::Relaxed);
        shared.decode_done.store(false, Ordering::Release);
        shared.ended.store(false, Ordering::Release);
        shared.zero_meters();

        let stop = Arc::new(AtomicBool::new(false));
        let decode_stop = stop.clone();
        let decode_shared = shared.clone();
        let join = thread::Builder::new()
            .name("audio-decode".into())
            .spawn(move || run_decode(decoder, producer, decode_stop, decode_shared, out_rate))
            .map_err(|e| format!("failed to start decode thread: {e}"))?;

        let stream = build_stream(&device, &supported, consumer, shared)?;
        self.session = Some(Session {
            _stream: stream,
            stop,
            join: Some(join),
        });
        Ok(duration)
    }
}

// ---------------------------------------------------------------------------
// Decode thread: file → f32 stereo → resample → ring buffer.
// ---------------------------------------------------------------------------

fn run_decode(
    mut decoder: AudioFileDecoder,
    mut producer: Producer<f32>,
    stop: Arc<AtomicBool>,
    shared: Arc<Shared>,
    out_rate: u32,
) {
    let in_rate = decoder.sample_rate;
    let mut resampler: Option<FftFixedIn<f32>> = if in_rate != out_rate {
        match FftFixedIn::new(in_rate as usize, out_rate as usize, RESAMPLE_CHUNK, 2, 2) {
            Ok(r) => Some(r),
            Err(e) => {
                eprintln!("resampler init failed ({in_rate} → {out_rate}): {e}");
                shared.decode_done.store(true, Ordering::Release);
                return;
            }
        }
    } else {
        None
    };

    // Planar accumulators feeding the fixed-size resampler input.
    let mut acc_l: Vec<f32> = Vec::with_capacity(RESAMPLE_CHUNK * 4);
    let mut acc_r: Vec<f32> = Vec::with_capacity(RESAMPLE_CHUNK * 4);

    'decode: loop {
        if stop.load(Ordering::Acquire) {
            break;
        }
        match decoder.next_stereo() {
            Ok(Some(chunk)) => match resampler.as_mut() {
                Some(rs) => {
                    for frame in chunk.chunks_exact(2) {
                        acc_l.push(frame[0]);
                        acc_r.push(frame[1]);
                    }
                    while acc_l.len() >= RESAMPLE_CHUNK {
                        let in_l: Vec<f32> = acc_l.drain(..RESAMPLE_CHUNK).collect();
                        let in_r: Vec<f32> = acc_r.drain(..RESAMPLE_CHUNK).collect();
                        match rs.process(&[in_l, in_r], None) {
                            Ok(out) => {
                                if !push_planar(&mut producer, &out, &stop) {
                                    break 'decode;
                                }
                            }
                            Err(e) => {
                                eprintln!("resample error: {e}");
                                break 'decode;
                            }
                        }
                    }
                }
                None => {
                    if !push_interleaved(&mut producer, &chunk, &stop) {
                        break 'decode;
                    }
                }
            },
            Ok(None) => {
                // Flush the resampler tail so the last fraction of a second plays.
                if let Some(rs) = resampler.as_mut() {
                    if !acc_l.is_empty() {
                        if let Ok(out) =
                            rs.process_partial(Some(&[acc_l.clone(), acc_r.clone()]), None)
                        {
                            push_planar(&mut producer, &out, &stop);
                        }
                    }
                    if let Ok(out) = rs.process_partial(None::<&[Vec<f32>]>, None) {
                        push_planar(&mut producer, &out, &stop);
                    }
                }
                break;
            }
            Err(e) => {
                eprintln!("decode error: {e}");
                break;
            }
        }
    }

    shared.decode_done.store(true, Ordering::Release);
}

/// Push planar L/R buffers as interleaved samples; false means we were stopped.
fn push_planar(producer: &mut Producer<f32>, planar: &[Vec<f32>], stop: &AtomicBool) -> bool {
    if planar.len() < 2 {
        return true;
    }
    let (l, r) = (&planar[0], &planar[1]);
    let mut i = 0;
    while i < l.len().min(r.len()) {
        if stop.load(Ordering::Acquire) {
            return false;
        }
        if producer.slots() >= 2 {
            let _ = producer.push(l[i]);
            let _ = producer.push(r[i]);
            i += 1;
        } else {
            thread::sleep(Duration::from_millis(5));
        }
    }
    true
}

fn push_interleaved(producer: &mut Producer<f32>, samples: &[f32], stop: &AtomicBool) -> bool {
    let mut i = 0;
    while i < samples.len() {
        if stop.load(Ordering::Acquire) {
            return false;
        }
        match producer.push(samples[i]) {
            Ok(()) => i += 1,
            Err(_) => thread::sleep(Duration::from_millis(5)),
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Realtime output stream. The callback is allocation-free and lock-free:
// it only pops the ring buffer and touches atomics.
// ---------------------------------------------------------------------------

pub(crate) fn build_stream(
    device: &Device,
    supported: &cpal::SupportedStreamConfig,
    consumer: Consumer<f32>,
    shared: Arc<Shared>,
) -> Result<Stream, String> {
    let config = supported.config();
    match supported.sample_format() {
        cpal::SampleFormat::F32 => build_stream_for::<f32>(device, &config, consumer, shared),
        cpal::SampleFormat::I16 => build_stream_for::<i16>(device, &config, consumer, shared),
        cpal::SampleFormat::U16 => build_stream_for::<u16>(device, &config, consumer, shared),
        other => Err(format!("unsupported output sample format: {other}")),
    }
}

fn build_stream_for<T: SizedSample + FromSample<f32>>(
    device: &Device,
    config: &StreamConfig,
    mut consumer: Consumer<f32>,
    shared: Arc<Shared>,
) -> Result<Stream, String> {
    let channels = (config.channels as usize).max(1);

    // Live-broadcast tee: a per-stream ring whose Consumer is registered in
    // `shared.bcast_cons` for the broadcast worker to drain. The Producer is
    // moved into the callback and pushed (lock-free) only while broadcasting.
    // ~4s of stereo headroom so a momentarily-stalled socket doesn't glitch.
    let (mut bcast_prod, bcast_cons) = RingBuffer::<f32>::new(config.sample_rate.0 as usize * 8);
    *lock_unpoisoned(&shared.bcast_cons) = Some(bcast_cons);

    let stream = device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                let playing = shared.state.load(Ordering::Relaxed) == STATE_PLAYING;
                let volume = f32::from_bits(shared.volume_bits.load(Ordering::Relaxed));
                let decode_done = shared.decode_done.load(Ordering::Acquire);
                let broadcasting = shared.broadcasting.load(Ordering::Relaxed);
                let frames = data.len() / channels;
                let mut consumed: u64 = 0;
                let (mut peak_l, mut peak_r) = (0.0f32, 0.0f32);
                let (mut sum_l, mut sum_r) = (0.0f32, 0.0f32);

                for frame in data.chunks_mut(channels) {
                    let (mut l, mut r) = (0.0f32, 0.0f32);
                    if playing && consumer.slots() >= 2 {
                        l = consumer.pop().unwrap_or(0.0);
                        r = consumer.pop().unwrap_or(0.0);
                        consumed += 1;
                    }
                    l *= volume;
                    r *= volume;
                    // Tee the post-volume mix to the broadcaster (drop on overflow).
                    if broadcasting {
                        let _ = bcast_prod.push(l);
                        let _ = bcast_prod.push(r);
                    }
                    peak_l = peak_l.max(l.abs());
                    peak_r = peak_r.max(r.abs());
                    sum_l += l * l;
                    sum_r += r * r;
                    if channels == 1 {
                        frame[0] = T::from_sample((l + r) * 0.5);
                    } else {
                        frame[0] = T::from_sample(l);
                        frame[1] = T::from_sample(r);
                        for sample in frame.iter_mut().skip(2) {
                            *sample = T::from_sample(0.0f32);
                        }
                    }
                }

                if consumed > 0 {
                    shared.frames_played.fetch_add(consumed, Ordering::Relaxed);
                }
                if playing && frames > 0 {
                    let n = frames as f32;
                    shared
                        .peak_l_bits
                        .store(peak_l.to_bits(), Ordering::Relaxed);
                    shared
                        .peak_r_bits
                        .store(peak_r.to_bits(), Ordering::Relaxed);
                    shared
                        .rms_l_bits
                        .store((sum_l / n).sqrt().to_bits(), Ordering::Relaxed);
                    shared
                        .rms_r_bits
                        .store((sum_r / n).sqrt().to_bits(), Ordering::Relaxed);
                }
                if playing && consumed == 0 && decode_done {
                    shared.ended.store(true, Ordering::Release);
                }
            },
            |err| eprintln!("audio stream error: {err}"),
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track_with_capability(capability: Capability) -> Track {
        Track {
            id: 1,
            title: Some("Radio Stream".into()),
            artist: None,
            album: None,
            year: None,
            genre: None,
            bpm: None,
            musical_key: None,
            duration_ms: None,
            uri: "https://example.com/stream".into(),
            source_kind: "radio".into(),
            capability,
            media_type: "music".into(),
            fingerprint: None,
            musicbrainz_id: None,
            art_path: None,
            rating: 0,
            play_count: 0,
            added_at: 0,
        }
    }

    /// 2-second 440 Hz stereo sine WAV for end-to-end playback.
    fn write_sine_wav(path: &std::path::Path) {
        let rate: u32 = 44_100;
        let secs = 2u32;
        let n = rate * secs;
        let data_len = n * 4; // stereo 16-bit
        let mut bytes = Vec::with_capacity(44 + data_len as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 4).to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..n {
            let t = i as f32 / rate as f32;
            let v = (0.5 * (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 32767.0) as i16;
            bytes.extend_from_slice(&v.to_le_bytes());
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        std::fs::write(path, bytes).expect("write fixture wav");
    }

    fn owned_track(uri: &str) -> Track {
        let mut t = track_with_capability(Capability::Owned);
        t.uri = uri.into();
        t.title = Some("Sine Test".into());
        t
    }

    /// Full pipeline: decode → resample → ring buffer → cpal output, with
    /// position tracking and real meter levels. Needs an output device, so
    /// it is ignored by default; run with `cargo test -- --include-ignored`.
    #[test]
    #[ignore = "requires an audio output device"]
    fn engine_plays_seeks_pauses_and_meters_move() {
        let dir = std::env::temp_dir().join(format!("stack-engine-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let wav = dir.join("sine.wav");
        write_sine_wav(&wav);

        let engine = EngineHandle::new().expect("engine should start");
        engine.set_volume(0.05); // keep the test quiet
        engine
            .load(owned_track(&wav.to_string_lossy()))
            .expect("load OWNED wav");

        let np = engine.now_playing().expect("now playing after load");
        assert_eq!(np.state, PlaybackState::Paused, "load leaves engine paused");
        assert_eq!(np.track.duration_ms, Some(2000));

        engine.play().expect("play");
        std::thread::sleep(Duration::from_millis(700));
        let np = engine.now_playing().expect("now playing");
        assert_eq!(np.state, PlaybackState::Playing);
        assert!(
            np.position_ms > 200,
            "position should advance, got {}ms",
            np.position_ms
        );
        let peak = f32::from_bits(engine.shared.peak_l_bits.load(Ordering::Relaxed));
        let rms = f32::from_bits(engine.shared.rms_l_bits.load(Ordering::Relaxed));
        assert!(peak > 0.001, "peak meter should move, got {peak}");
        assert!(rms > 0.0005, "rms meter should move, got {rms}");

        engine.pause().expect("pause");
        std::thread::sleep(Duration::from_millis(150));
        let frozen = engine.now_playing().expect("now playing").position_ms;
        std::thread::sleep(Duration::from_millis(300));
        let np = engine.now_playing().expect("now playing");
        assert_eq!(np.state, PlaybackState::Paused);
        assert_eq!(np.position_ms, frozen, "position must freeze while paused");

        engine.seek(1500).expect("seek");
        let np = engine.now_playing().expect("now playing");
        assert!(
            (1400..=1700).contains(&np.position_ms),
            "seek should land near 1500ms, got {}ms",
            np.position_ms
        );

        engine.play().expect("resume");
        // ~500ms remain; wait for natural end-of-track.
        std::thread::sleep(Duration::from_millis(1500));
        assert_eq!(
            engine.now_playing().expect("now playing").state,
            PlaybackState::Stopped,
            "engine should stop at end of track"
        );

        engine.stop().expect("stop");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "requires an audio output device"]
    fn device_enumeration_reports_a_default() {
        let devices = list_devices().expect("device enumeration");
        assert!(!devices.is_empty(), "expected at least one output device");
        assert_eq!(
            devices.iter().filter(|d| d.is_default).count(),
            1,
            "exactly one device should be marked default: {devices:?}"
        );
    }

    /// M2 live path: capture from the default input, monitor through the
    /// default output, record a second, and confirm the WAV lands on disk.
    /// Needs input+output devices and microphone permission.
    #[test]
    #[ignore = "requires audio input/output devices and mic permission"]
    fn line_in_monitors_and_records() {
        let engine = EngineHandle::new().expect("engine should start");
        engine.set_volume(0.0); // avoid a feedback loop through the speakers

        let info = match engine.start_line_in("aux", None) {
            Ok(i) => i,
            Err(e) => {
                eprintln!("SKIP: line-in unavailable in this environment: {e}");
                return;
            }
        };
        assert!(!info.input_device.is_empty());
        assert_eq!(engine.status().mode, "lineIn");
        assert!(engine.now_playing().is_none(), "no track while line-in is live");

        // Monitor clock must advance even with a silent input.
        std::thread::sleep(Duration::from_millis(600));
        let elapsed = engine.shared.position_ms();
        assert!(elapsed > 200, "monitor clock should advance, got {elapsed}ms");

        // DSP params reach the relay without breaking the stream.
        engine.set_dsp(DspParams {
            riaa: true,
            bass_db: 6.0,
            treble_db: -3.0,
        });
        std::thread::sleep(Duration::from_millis(200));
        assert!(engine.status().riaa);

        // Record ~1 s and verify a decodable OWNED-quality WAV is produced.
        let dir =
            std::env::temp_dir().join(format!("stack-linein-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let wav = dir.join("capture.wav");
        engine
            .start_recording(
                wav.clone(),
                crate::audio::sinks::RecordFormat::Wav {
                    bits: crate::audio::sinks::PcmBits::F32,
                },
            )
            .expect("start recording");
        std::thread::sleep(Duration::from_millis(1000));
        assert!(engine.status().recording);
        let stats = engine.stop_recording().expect("stop recording");
        assert!(
            stats.duration_ms >= 700,
            "expected ~1s recorded, got {}ms",
            stats.duration_ms
        );
        let mut dec = AudioFileDecoder::open(&wav).expect("recorded wav must decode");
        assert_eq!(dec.sample_rate, info.input_rate);
        let mut frames = 0usize;
        while let Ok(Some(chunk)) = dec.next_stereo() {
            frames += chunk.len() / 2;
        }
        assert_eq!(frames as u64, stats.frames, "decoded frames match stats");

        engine.stop().expect("stop");
        assert_eq!(engine.status().mode, "library");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// DoD: the engine must refuse to load any non-OWNED track.
    #[test]
    fn engine_rejects_non_owned_tracks() {
        let engine = EngineHandle::new().expect("engine should start");
        for capability in [Capability::StreamPlayable, Capability::LinkOnly] {
            let err = engine
                .load(track_with_capability(capability))
                .expect_err("non-OWNED track must be refused");
            let msg = err.to_string();
            assert!(
                msg.contains("capability gate"),
                "expected capability-gate error, got: {msg}"
            );
            assert!(engine.now_playing().is_none());
        }
    }
}
