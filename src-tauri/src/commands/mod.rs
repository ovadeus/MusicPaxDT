pub mod streams;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, State};

use crate::audio::engine::{self, AudioDeviceInfo, EngineStatus, NowPlaying};
use crate::audio::input;
use crate::audio::sinks::RecordFormat;
use crate::error::{AppError, AppResult};
use crate::library::model::{Capability, ImportResult, NewTrack, Track};
use crate::library::{db, scan};
use crate::state::{lock_unpoisoned, AppState};

const LINE_IN_SOURCES: &[&str] = &["phono", "tape", "cd", "aux"];

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn local_timestamp() -> String {
    let now = time::OffsetDateTime::now_local()
        .unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    format!(
        "{:04}-{:02}-{:02} {:02}.{:02}.{:02}",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

fn source_label(source: &str) -> String {
    let mut chars = source.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

#[tauri::command]
pub async fn import_folder(path: String, state: State<'_, AppState>) -> AppResult<ImportResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        scan::import_folder(&conn, &PathBuf::from(path))
    })
    .await
    .map_err(|e| AppError::Other(format!("import task failed: {e}")))?
}

#[tauri::command]
pub async fn list_tracks(
    query: Option<String>,
    sort: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    state: State<'_, AppState>,
) -> AppResult<Vec<Track>> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        db::list_tracks(
            &conn,
            query.as_deref(),
            sort.as_deref(),
            limit.unwrap_or(1000),
            offset.unwrap_or(0),
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("query task failed: {e}")))?
}

#[tauri::command]
pub async fn get_audio_devices() -> AppResult<Vec<AudioDeviceInfo>> {
    tauri::async_runtime::spawn_blocking(engine::list_devices)
        .await
        .map_err(|e| AppError::Audio(format!("device query failed: {e}")))?
}

#[tauri::command]
pub async fn set_output_device(id: String, state: State<'_, AppState>) -> AppResult<()> {
    let engine = state.engine.clone();
    let name = if id.is_empty() || id == "default" {
        None
    } else {
        Some(id)
    };
    tauri::async_runtime::spawn_blocking(move || engine.set_device(name))
        .await
        .map_err(|e| AppError::Audio(format!("device switch failed: {e}")))?
}

/// Loads a track into the player. The engine enforces the capability gate:
/// anything other than OWNED is refused.
#[tauri::command]
pub async fn load_track(track_id: i64, state: State<'_, AppState>) -> AppResult<()> {
    let db = state.db.clone();
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let track = {
            let conn = lock_unpoisoned(&db);
            db::get_track(&conn, track_id)?
        };
        engine.load(track)?;
        let played_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = lock_unpoisoned(&db);
        db::record_play(&conn, track_id, played_at)
    })
    .await
    .map_err(|e| AppError::Audio(format!("load task failed: {e}")))?
}

#[tauri::command]
pub fn play(state: State<'_, AppState>) -> AppResult<()> {
    state.engine.play()
}

#[tauri::command]
pub fn pause(state: State<'_, AppState>) -> AppResult<()> {
    state.engine.pause()
}

#[tauri::command]
pub fn stop(state: State<'_, AppState>) -> AppResult<()> {
    state.engine.stop()
}

#[tauri::command]
pub fn seek(position_ms: u64, state: State<'_, AppState>) -> AppResult<()> {
    state.engine.seek(position_ms)
}

#[tauri::command]
pub fn set_volume(level: f32, state: State<'_, AppState>) -> AppResult<()> {
    if !(0.0..=1.0).contains(&level) {
        return Err(AppError::Other(format!(
            "volume must be between 0.0 and 1.0, got {level}"
        )));
    }
    state.engine.set_volume(level);
    Ok(())
}

#[tauri::command]
pub fn now_playing(state: State<'_, AppState>) -> Option<NowPlaying> {
    state.engine.now_playing()
}

// ---------------------------------------------------------------------------
// M2: receiver — line-in sources, DSP, recording.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_audio_input_devices() -> AppResult<Vec<AudioDeviceInfo>> {
    tauri::async_runtime::spawn_blocking(|| input::list_input_devices().map_err(AppError::Audio))
        .await
        .map_err(|e| AppError::Audio(format!("device query failed: {e}")))?
}

/// Switch the receiver to a line-in source. Uses the device routed to that
/// source (settings) unless one is given explicitly. Phono engages RIAA.
#[tauri::command]
pub async fn start_line_in(
    source: String,
    input_device: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<EngineStatus> {
    if !LINE_IN_SOURCES.contains(&source.as_str()) {
        return Err(AppError::Other(format!(
            "unknown line-in source '{source}' (expected one of {LINE_IN_SOURCES:?})"
        )));
    }
    let engine = state.engine.clone();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let routed = match input_device {
            Some(d) => Some(d),
            None => {
                let conn = lock_unpoisoned(&db);
                db::get_setting(&conn, &format!("input_device.{source}"))?
            }
        };
        engine.start_line_in(&source, routed)?;
        let mut params = engine.shared.dsp_params();
        params.riaa = source == "phono";
        engine.set_dsp(params);
        Ok(engine.status())
    })
    .await
    .map_err(|e| AppError::Audio(format!("line-in task failed: {e}")))?
}

/// Persist which capture device feeds a receiver source; restarts the chain
/// if that source is live.
#[tauri::command]
pub async fn set_input_device(
    source: String,
    device_id: String,
    state: State<'_, AppState>,
) -> AppResult<EngineStatus> {
    if !LINE_IN_SOURCES.contains(&source.as_str()) {
        return Err(AppError::Other(format!("unknown line-in source '{source}'")));
    }
    let engine = state.engine.clone();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let conn = lock_unpoisoned(&db);
            db::set_setting(&conn, &format!("input_device.{source}"), &device_id)?;
        }
        if engine.line_in_info().map(|i| i.source) == Some(source.clone()) {
            engine.start_line_in(&source, Some(device_id))?;
        }
        Ok(engine.status())
    })
    .await
    .map_err(|e| AppError::Audio(format!("routing task failed: {e}")))?
}

#[tauri::command]
pub fn set_riaa(on: bool, state: State<'_, AppState>) -> EngineStatus {
    let mut params = state.engine.shared.dsp_params();
    params.riaa = on;
    state.engine.set_dsp(params);
    state.engine.status()
}

#[tauri::command]
pub fn set_tone(bass_db: f32, treble_db: f32, state: State<'_, AppState>) -> EngineStatus {
    let mut params = state.engine.shared.dsp_params();
    params.bass_db = bass_db;
    params.treble_db = treble_db;
    state.engine.set_dsp(params);
    state.engine.status()
}

#[tauri::command]
pub fn engine_status(state: State<'_, AppState>) -> EngineStatus {
    state.engine.status()
}

/// Resolve the recording format from persisted settings (defaults: WAV,
/// float32, MP3 320 kbps when MP3 is selected).
fn recording_format(conn: &rusqlite::Connection) -> AppResult<RecordFormat> {
    let format = db::get_setting(conn, "recording.format")?.unwrap_or_else(|| "wav".into());
    let bit_depth = db::get_setting(conn, "recording.bit_depth")?.unwrap_or_else(|| "32".into());
    let mp3_kbps = db::get_setting(conn, "recording.mp3_bitrate")?.unwrap_or_else(|| "320".into());
    Ok(RecordFormat::from_settings(&format, &bit_depth, &mp3_kbps))
}

/// Start recording the live line-in source into the app's recordings folder
/// using the format configured in Settings. Returns the file path.
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let engine = state.engine.clone();
    let db = state.db.clone();
    let info = engine
        .line_in_info()
        .ok_or_else(|| AppError::Audio("select a line-in source before recording".into()))?;
    let format = {
        let conn = lock_unpoisoned(&db);
        recording_format(&conn)?
    };
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("no app data dir: {e}")))?
        .join("recordings");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!(
        "{} {}.{}",
        source_label(&info.source),
        local_timestamp(),
        format.extension()
    ));
    let display = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || engine.start_recording(path, format))
        .await
        .map_err(|e| AppError::Audio(format!("recording task failed: {e}")))??;
    Ok(display)
}

// ---------------------------------------------------------------------------
// Settings: generic key-value store backing the Settings UI.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        Ok(db::get_all_settings(&conn)?.into_iter().collect())
    })
    .await
    .map_err(|e| AppError::Other(format!("settings task failed: {e}")))?
}

#[tauri::command]
pub async fn set_setting(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        db::set_setting(&conn, &key, &value)
    })
    .await
    .map_err(|e| AppError::Other(format!("settings task failed: {e}")))?
}

/// Human-readable summary of the active recording format (for the receiver
/// panel chip).
#[tauri::command]
pub fn recording_format_label(state: State<'_, AppState>) -> AppResult<String> {
    let conn = lock_unpoisoned(&state.db);
    Ok(recording_format(&conn)?.label())
}

/// Stop the recording, finalize the WAV, and add it to the library as an
/// OWNED track (it is the user's own line-in signal).
#[tauri::command]
pub async fn stop_recording(state: State<'_, AppState>) -> AppResult<Track> {
    let engine = state.engine.clone();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = engine
            .line_in_info()
            .map(|i| i.source)
            .unwrap_or_else(|| "line-in".into());
        let stats = engine.stop_recording()?;
        let title = PathBuf::from(&stats.path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{} recording", source_label(&source)));
        let track = NewTrack {
            title: Some(title),
            artist: None,
            album: None,
            year: None,
            genre: None,
            duration_ms: Some(stats.duration_ms as i64),
            uri: stats.path.clone(),
            source_kind: "line_in".into(),
            capability: Capability::Owned,
        };
        let conn = lock_unpoisoned(&db);
        db::insert_track(&conn, &track, now_unix())?;
        db::get_track_by_uri(&conn, &stats.path)?
            .ok_or_else(|| AppError::Other("recorded track vanished after insert".into()))
    })
    .await
    .map_err(|e| AppError::Audio(format!("stop-recording task failed: {e}")))?
}
