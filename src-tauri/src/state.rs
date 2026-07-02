use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::Connection;

use crate::audio::broadcast::Broadcaster;
use crate::audio::engine::EngineHandle;
use crate::audio::screen_audio::ScreenAudio;
use crate::audio::viz_capture::VizCapture;

/// Lock a mutex, recovering from poisoning (a panicked holder) instead of
/// propagating the panic — the DB/engine state stays usable.
pub fn lock_unpoisoned<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub engine: Arc<EngineHandle>,
    /// Live "Go Live" broadcaster (Icecast source client).
    pub broadcaster: Arc<Broadcaster>,
    /// Active visualizer system-audio capture (e.g. a loopback device), if any.
    pub viz_capture: Mutex<Option<VizCapture>>,
    /// Active no-install ScreenCaptureKit system-audio capture, if any.
    pub screen_audio: Mutex<Option<ScreenAudio>>,
}
