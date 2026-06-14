//! "Go Live" broadcaster — an Icecast2 source client.
//!
//! Takes the engine's teed output mix (post-volume stereo f32 from the cpal
//! callback), encodes MP3, and streams it to a Radio King / Icecast mount.
//!
//! Realtime safety: the audio callback only pushes into a lock-free ring
//! (`Shared::bcast_cons`). THIS worker is an ordinary thread — it drains that
//! ring under a mutex, pads idle/underrun gaps with silence so the connection
//! never starves, encodes, and writes to the socket. It survives track changes
//! because it always drains whatever consumer is currently registered (the
//! engine swaps in a fresh one each time it rebuilds the output stream).
//!
//! What airs: only OWNED library playback + line-in/aux (the engine output).
//! STREAM_PLAYABLE audio (YouTube/radio) plays in the webview and never reaches
//! this tee, so it can't be re-broadcast.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::audio::engine::Shared;
use crate::audio::sinks::build_mp3_encoder;
use crate::state::lock_unpoisoned;

/// Live connection settings (host/port/mount/password come from the user's
/// Radio King → Live tab). Password is fetched from the keychain by the command
/// layer; it lives here only for the duration of a session.
#[derive(Clone, Debug)]
pub struct IcecastConfig {
    pub host: String,
    pub port: u16,
    pub mount: String,
    pub username: String,
    pub password: String,
    pub bitrate: u32,
    pub name: String,
    pub description: String,
    pub genre: String,
    pub url: String,
    pub public: bool,
}

const ST_IDLE: u8 = 0;
const ST_CONNECTING: u8 = 1;
const ST_LIVE: u8 = 2;
const ST_RECONNECTING: u8 = 3;
const ST_ERROR: u8 = 4;

fn state_str(s: u8) -> &'static str {
    match s {
        ST_CONNECTING => "connecting",
        ST_LIVE => "live",
        ST_RECONNECTING => "reconnecting",
        ST_ERROR => "error",
        _ => "idle",
    }
}

struct Status {
    state: AtomicU8,
    sent_bytes: AtomicU64,
    started: Mutex<Option<Instant>>,
    message: Mutex<String>,
    stop: AtomicBool,
}

impl Status {
    fn new() -> Self {
        Status {
            state: AtomicU8::new(ST_IDLE),
            sent_bytes: AtomicU64::new(0),
            started: Mutex::new(None),
            message: Mutex::new(String::new()),
            stop: AtomicBool::new(false),
        }
    }

    fn set(&self, state: u8, msg: &str) {
        self.state.store(state, Ordering::Relaxed);
        *lock_unpoisoned(&self.message) = msg.to_string();
    }

    fn elapsed_ms(&self) -> u64 {
        match *lock_unpoisoned(&self.started) {
            Some(t) if self.state.load(Ordering::Relaxed) == ST_LIVE => {
                t.elapsed().as_millis() as u64
            }
            _ => 0,
        }
    }

    fn snapshot(&self, bitrate: u32) -> BroadcastStatus {
        BroadcastStatus {
            state: state_str(self.state.load(Ordering::Relaxed)).to_string(),
            elapsed_ms: self.elapsed_ms(),
            sent_bytes: self.sent_bytes.load(Ordering::Relaxed),
            bitrate,
            message: lock_unpoisoned(&self.message).clone(),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastStatus {
    pub state: String,
    pub elapsed_ms: u64,
    pub sent_bytes: u64,
    pub bitrate: u32,
    pub message: String,
}

/// Owns the broadcast worker thread. Stored in `AppState`.
pub struct Broadcaster {
    status: Arc<Status>,
    join: Mutex<Option<JoinHandle<()>>>,
    bitrate: AtomicU32,
}

impl Default for Broadcaster {
    fn default() -> Self {
        Broadcaster {
            status: Arc::new(Status::new()),
            join: Mutex::new(None),
            bitrate: AtomicU32::new(128),
        }
    }
}

impl Broadcaster {
    pub fn is_live(&self) -> bool {
        self.status.state.load(Ordering::Relaxed) != ST_IDLE
    }

    /// Start (or restart) broadcasting. Sets the engine tee live and spawns the
    /// worker. Returns immediately; progress arrives via `broadcast-state` events.
    pub fn start(&self, shared: Arc<Shared>, cfg: IcecastConfig, app: AppHandle) {
        self.stop(&shared); // tear down any prior session cleanly
        self.bitrate.store(cfg.bitrate, Ordering::Relaxed);
        self.status.stop.store(false, Ordering::Relaxed);
        self.status.sent_bytes.store(0, Ordering::Relaxed);
        self.status.set(ST_CONNECTING, "");
        shared.broadcasting.store(true, Ordering::Relaxed);

        let status = self.status.clone();
        let bitrate = cfg.bitrate;
        let handle = thread::Builder::new()
            .name("broadcast".into())
            .spawn(move || run_worker(shared, cfg, status, app, bitrate))
            .ok();
        *lock_unpoisoned(&self.join) = handle;
    }

    /// Stop broadcasting and wait for the worker to flush and disconnect.
    pub fn stop(&self, shared: &Shared) {
        self.status.stop.store(true, Ordering::Relaxed);
        shared.broadcasting.store(false, Ordering::Relaxed);
        if let Some(j) = lock_unpoisoned(&self.join).take() {
            let _ = j.join();
        }
        self.status.state.store(ST_IDLE, Ordering::Relaxed);
        *lock_unpoisoned(&self.status.started) = None;
    }

    pub fn status(&self) -> BroadcastStatus {
        self.status.snapshot(self.bitrate.load(Ordering::Relaxed))
    }
}

/// Build the Icecast2 source handshake request. Pure (no I/O) for testability.
pub fn build_source_request(cfg: &IcecastConfig, sample_rate: u32) -> String {
    let auth = base64::engine::general_purpose::STANDARD
        .encode(format!("{}:{}", cfg.username, cfg.password));
    let mount = if cfg.mount.starts_with('/') {
        cfg.mount.clone()
    } else {
        format!("/{}", cfg.mount)
    };
    let public = if cfg.public { 1 } else { 0 };
    format!(
        "SOURCE {mount} HTTP/1.0\r\n\
         Authorization: Basic {auth}\r\n\
         User-Agent: MUSICPAX/0.1\r\n\
         Content-Type: audio/mpeg\r\n\
         Ice-Public: {public}\r\n\
         Ice-Name: {name}\r\n\
         Ice-Description: {desc}\r\n\
         Ice-Genre: {genre}\r\n\
         Ice-URL: {url}\r\n\
         Ice-Audio-Info: ice-samplerate={sr};ice-bitrate={br};ice-channels=2\r\n\r\n",
        name = cfg.name,
        desc = cfg.description,
        genre = cfg.genre,
        url = cfg.url,
        sr = sample_rate,
        br = cfg.bitrate,
    )
}

/// Interpret the server's first response line.
fn handshake_result(first_line: &str) -> Result<(), String> {
    if first_line.contains("200") || first_line.contains("OK") {
        Ok(())
    } else if first_line.contains("401") {
        Err("authentication failed — check your source password".into())
    } else if first_line.contains("403") {
        Err("mount point refused (already in use, or wrong mount)".into())
    } else {
        Err(format!(
            "server rejected the connection: {}",
            first_line.trim()
        ))
    }
}

fn connect_and_handshake(cfg: &IcecastConfig, sample_rate: u32) -> Result<TcpStream, String> {
    let addr = format!("{}:{}", cfg.host, cfg.port);
    let mut sock = TcpStream::connect(&addr).map_err(|e| format!("connect {addr}: {e}"))?;
    sock.set_nodelay(true).ok();
    sock.write_all(build_source_request(cfg, sample_rate).as_bytes())
        .map_err(|e| format!("handshake write failed: {e}"))?;
    sock.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut buf = [0u8; 1024];
    let n = sock
        .read(&mut buf)
        .map_err(|e| format!("no handshake response: {e}"))?;
    let resp = String::from_utf8_lossy(&buf[..n]);
    handshake_result(resp.lines().next().unwrap_or(""))?;
    sock.set_read_timeout(None).ok();
    Ok(sock)
}

fn emit(app: &AppHandle, status: &Status, bitrate: u32) {
    let _ = app.emit("broadcast-state", status.snapshot(bitrate));
}

fn run_worker(shared: Arc<Shared>, cfg: IcecastConfig, status: Arc<Status>, app: AppHandle, bitrate: u32) {
    use mp3lame_encoder::{max_required_buffer_size, DualPcm};

    // Encode at the device's output rate (44.1k/48k are both valid MP3 rates),
    // so no resampling. Captured once; a device change ends the session.
    let sample_rate = shared.out_rate.load(Ordering::Relaxed).max(8000);

    let mut backoff_steps = 1u64;
    let mut left: Vec<f32> = Vec::new();
    let mut right: Vec<f32> = Vec::new();
    let mut out: Vec<u8> = Vec::new();

    'session: loop {
        if status.stop.load(Ordering::Relaxed) {
            break;
        }
        status.set(ST_CONNECTING, "");
        emit(&app, &status, bitrate);

        let mut sock = match connect_and_handshake(&cfg, sample_rate) {
            Ok(s) => s,
            Err(e) => {
                if status.stop.load(Ordering::Relaxed) {
                    break;
                }
                status.set(ST_RECONNECTING, &e);
                emit(&app, &status, bitrate);
                // Backoff up to ~15s, but stay responsive to stop.
                let ticks = backoff_steps * 10;
                for _ in 0..ticks {
                    if status.stop.load(Ordering::Relaxed) {
                        break 'session;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                backoff_steps = (backoff_steps * 2).min(15);
                continue;
            }
        };
        backoff_steps = 1;

        let mut encoder = match build_mp3_encoder(sample_rate, cfg.bitrate) {
            Ok(e) => e,
            Err(e) => {
                status.set(ST_ERROR, &e);
                emit(&app, &status, bitrate);
                break;
            }
        };

        status.set(ST_LIVE, "");
        *lock_unpoisoned(&status.started) = Some(Instant::now());
        emit(&app, &status, bitrate);

        let start = Instant::now();
        let mut sent_frames: u64 = 0; // per-channel frames sent this connection
        let mut emit_tick: u32 = 0;

        loop {
            if status.stop.load(Ordering::Relaxed) {
                // Flush the encoder tail, then end the whole session.
                out.clear();
                out.reserve(max_required_buffer_size(0));
                if encoder
                    .flush_to_vec::<mp3lame_encoder::FlushNoGap>(&mut out)
                    .is_ok()
                {
                    let _ = sock.write_all(&out);
                }
                let _ = sock.flush();
                break 'session;
            }

            // A device change alters the output rate — end the session cleanly.
            if shared.out_rate.load(Ordering::Relaxed).max(8000) != sample_rate {
                status.set(ST_ERROR, "output device changed — go live again");
                emit(&app, &status, bitrate);
                break 'session;
            }

            // Wall-clock pacing: how many frames SHOULD we have sent by now?
            let target = (start.elapsed().as_secs_f64() * sample_rate as f64) as u64;
            let mut need = target.saturating_sub(sent_frames);
            if need == 0 {
                thread::sleep(Duration::from_millis(20));
                continue;
            }
            need = need.min(sample_rate as u64); // cap a burst at ~1s

            left.clear();
            right.clear();
            let mut got: u64 = 0;
            {
                let mut guard = lock_unpoisoned(&shared.bcast_cons);
                if let Some(cons) = guard.as_mut() {
                    while got < need && cons.slots() >= 2 {
                        left.push(cons.pop().unwrap_or(0.0));
                        right.push(cons.pop().unwrap_or(0.0));
                        got += 1;
                    }
                }
            }
            // Pad underrun/idle with silence so the stream never starves.
            while got < need {
                left.push(0.0);
                right.push(0.0);
                got += 1;
            }
            sent_frames += got;

            out.clear();
            out.reserve(max_required_buffer_size(left.len()));
            if let Err(e) = encoder.encode_to_vec(
                DualPcm {
                    left: &left,
                    right: &right,
                },
                &mut out,
            ) {
                status.set(ST_ERROR, &format!("mp3 encode failed: {e}"));
                emit(&app, &status, bitrate);
                break 'session;
            }
            if let Err(e) = sock.write_all(&out) {
                status.set(ST_RECONNECTING, &format!("connection lost: {e}"));
                emit(&app, &status, bitrate);
                break; // inner loop → reconnect via outer 'session loop
            }
            status
                .sent_bytes
                .fetch_add(out.len() as u64, Ordering::Relaxed);

            emit_tick = emit_tick.wrapping_add(1);
            if emit_tick.is_multiple_of(15) {
                emit(&app, &status, bitrate);
            }
        }
    }

    shared.broadcasting.store(false, Ordering::Relaxed);
    status.state.store(ST_IDLE, Ordering::Relaxed);
    emit(&app, &status, bitrate);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> IcecastConfig {
        IcecastConfig {
            host: "live.radioking.com".into(),
            port: 8000,
            mount: "my-radio".into(),
            username: "source".into(),
            password: "secret".into(),
            bitrate: 128,
            name: "Test".into(),
            description: "Desc".into(),
            genre: "Pop".into(),
            url: "https://example.com".into(),
            public: false,
        }
    }

    #[test]
    fn handshake_has_source_line_auth_and_normalized_mount() {
        let req = build_source_request(&cfg(), 44_100);
        // Mount without a leading slash gets normalized.
        assert!(req.starts_with("SOURCE /my-radio HTTP/1.0\r\n"), "{req}");
        // Basic auth = base64("source:secret").
        let expected = base64::engine::general_purpose::STANDARD.encode("source:secret");
        assert!(req.contains(&format!("Authorization: Basic {expected}\r\n")));
        assert!(req.contains("Content-Type: audio/mpeg\r\n"));
        assert!(req.contains("Ice-Public: 0\r\n"));
        assert!(req.contains("ice-samplerate=44100;ice-bitrate=128;ice-channels=2"));
        assert!(req.ends_with("\r\n\r\n"));
    }

    #[test]
    fn leading_slash_mount_is_kept() {
        let mut c = cfg();
        c.mount = "/already".into();
        c.public = true;
        let req = build_source_request(&c, 48_000);
        assert!(req.starts_with("SOURCE /already HTTP/1.0\r\n"));
        assert!(req.contains("Ice-Public: 1\r\n"));
        assert!(req.contains("ice-samplerate=48000"));
    }

    #[test]
    fn handshake_result_maps_status_codes() {
        assert!(handshake_result("HTTP/1.0 200 OK").is_ok());
        assert!(handshake_result("ICY 200 OK").is_ok());
        assert!(handshake_result("HTTP/1.0 401 Unauthorized")
            .unwrap_err()
            .contains("password"));
        assert!(handshake_result("HTTP/1.0 403 Forbidden")
            .unwrap_err()
            .contains("mount"));
        assert!(handshake_result("HTTP/1.0 500 Boom").is_err());
    }
}
