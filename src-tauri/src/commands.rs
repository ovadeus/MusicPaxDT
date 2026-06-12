use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::State;

use crate::audio::engine::{self, AudioDeviceInfo, NowPlaying};
use crate::error::{AppError, AppResult};
use crate::library::model::{ImportResult, Track};
use crate::library::{db, scan};
use crate::state::{lock_unpoisoned, AppState};

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
