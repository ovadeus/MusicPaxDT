pub mod broadcast;
pub mod enrich;
pub mod share;
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
    media_type: Option<String>,
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
            media_type.as_deref(),
            limit.unwrap_or(1000),
            offset.unwrap_or(0),
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("query task failed: {e}")))?
}

/// Settings key for the Live Media folder.
const LIVE_MEDIA_DIR_KEY: &str = "live.media_dir";

/// The Live Media folder, if one has been chosen. Go Live airs only local
/// files, and this folder is the on-air list: aggregated sources (YouTube,
/// radio) can't be re-broadcast under their terms, so the live view is
/// deliberately just what's under here.
#[tauri::command]
pub fn live_media_dir(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let conn = lock_unpoisoned(&state.db);
    db::get_setting(&conn, LIVE_MEDIA_DIR_KEY)
}

/// Choose the Live Media folder and scan it. The files join the main library
/// as ordinary OWNED tracks (they are the user's own files); the Live Media
/// list is a filtered view of them, not a second copy.
#[tauri::command]
pub async fn set_live_media_dir(
    path: String,
    state: State<'_, AppState>,
) -> AppResult<ImportResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        db::set_setting(&conn, LIVE_MEDIA_DIR_KEY, path.trim())?;
        scan::import_folder(&conn, &PathBuf::from(path.trim()))
    })
    .await
    .map_err(|e| AppError::Other(format!("live media scan failed: {e}")))?
}

/// Re-scan the Live Media folder so files added since still show up. Dedupes
/// by uri, so this is safe to run every time Go Live opens.
#[tauri::command]
pub async fn rescan_live_media(state: State<'_, AppState>) -> AppResult<ImportResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        match db::get_setting(&conn, LIVE_MEDIA_DIR_KEY)? {
            Some(dir) if !dir.trim().is_empty() => scan::import_folder(&conn, &PathBuf::from(dir)),
            _ => Ok(ImportResult { imported: 0, skipped: 0, errors: Vec::new() }),
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("live media scan failed: {e}")))?
}

/// The Live Media list: every OWNED track under the chosen folder.
#[tauri::command]
pub async fn list_live_media(state: State<'_, AppState>) -> AppResult<Vec<Track>> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        match db::get_setting(&conn, LIVE_MEDIA_DIR_KEY)? {
            Some(dir) if !dir.trim().is_empty() => db::list_tracks_under(&conn, &dir),
            _ => Ok(Vec::new()),
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("live media query failed: {e}")))?
}

fn artist_bio_key(artist: &str) -> String {
    format!("artistbio.{}", artist.trim().to_lowercase())
}

/// Artist mini-biography for the Now Playing panel. A Curator-saved override
/// wins; otherwise we fetch Wikipedia's free summary (music-disambiguated so
/// e.g. "Chicago" resolves to the band, not the city).
#[tauri::command]
pub async fn artist_bio(
    artist: String,
    state: State<'_, AppState>,
) -> AppResult<Option<crate::sources::wikipedia::ArtistBio>> {
    let override_text = {
        let conn = lock_unpoisoned(&state.db);
        db::get_setting(&conn, &artist_bio_key(&artist))?.filter(|s| !s.trim().is_empty())
    };
    if let Some(text) = override_text {
        return Ok(Some(crate::sources::wikipedia::ArtistBio {
            extract: text,
            thumbnail: None,
            url: None,
            title: artist.trim().to_string(),
        }));
    }
    crate::sources::wikipedia::artist_bio(&artist)
        .await
        .map_err(AppError::Other)
}

/// Save (or clear, when empty) a Curator override for an artist's bio.
#[tauri::command]
pub async fn set_artist_bio(
    artist: String,
    extract: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = lock_unpoisoned(&state.db);
    db::set_setting(&conn, &artist_bio_key(&artist), extract.trim())?;
    Ok(())
}

/// Read a local image file and return it as a `data:` URL. Used for custom
/// thumbnails (the UI is served over http://localhost, so file:// paths won't
/// load; an embedded data URL works everywhere). Capped at 2 MB.
#[tauri::command]
pub async fn read_image_data_url(path: String) -> AppResult<String> {
    use base64::Engine;
    tauri::async_runtime::spawn_blocking(move || {
        // Only known image types — otherwise this command is a general
        // "read any file into the webview" primitive. Reject up front so an
        // arbitrary path can't be exfiltrated as a data URL.
        let mime = match PathBuf::from(&path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref()
        {
            Some("png") => "image/png",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            Some("svg") => "image/svg+xml",
            _ => return Err(AppError::Other("not an image file".into())),
        };
        // Size-check via metadata BEFORE reading, so a huge file can't be slurped
        // into memory just to be rejected.
        if std::fs::metadata(&path)?.len() > 2_000_000 {
            return Err(AppError::Other("image too large (max 2 MB)".into()));
        }
        let bytes = std::fs::read(&path)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("data:{mime};base64,{b64}"))
    })
    .await
    .map_err(|e| AppError::Other(format!("image task failed: {e}")))?
}

/// Edit a track's title/artist/album/year/genre. Updates the library row and,
/// for OWNED local files, writes the tags back to the file (best-effort, so a
/// read-only or unsupported file still updates the library).
// Args are the IPC params (one per editable field); a struct would change the
// command contract, so the count is intentional.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn update_track_metadata(
    track_id: i64,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    year: Option<i64>,
    genre: Option<String>,
    media_type: Option<String>,
    uri: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Track> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // A blank/absent uri means "leave it"; a present one must be a real
        // YouTube URL, which we normalize to a canonical watch URL so the embed
        // (which reads the video id straight off the uri) plays the new video.
        let uri = match uri.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(u) => Some(
                crate::sources::youtube::parse_video_id(u)
                    .map(|id| crate::sources::youtube::watch_url(&id))
                    .ok_or_else(|| {
                        AppError::Other("Not a valid YouTube video URL".to_string())
                    })?,
            ),
            None => None,
        };
        let conn = lock_unpoisoned(&db);
        // Only STREAM_PLAYABLE YouTube tracks may have their source swapped —
        // never rewrite a local file's path or another source's URI this way.
        if uri.is_some() {
            let existing = db::get_track(&conn, track_id)?;
            if existing.source_kind != "youtube" {
                return Err(AppError::Other(
                    "The source URL can only be changed for YouTube tracks".to_string(),
                ));
            }
            // Swapping the video: drop any stale cached cover so the grid and
            // Now Playing derive the new video's thumbnail from the new uri.
            db::clear_track_art_path(&conn, track_id)?;
        }
        let edit = db::TrackEdit {
            title,
            artist,
            album,
            year,
            genre,
            media_type,
            uri,
        };
        let track = db::update_track_metadata(&conn, track_id, &edit)?;
        // Persist to the file itself for owned local audio.
        if track.capability == Capability::Owned && track.source_kind == "local" {
            scan::write_tags(&track);
        }
        Ok(track)
    })
    .await
    .map_err(|e| AppError::Other(format!("metadata task failed: {e}")))?
}

/// Favorite / unfavorite a track (stored as rating >= 1). Powers the heart
/// toggle in the library and the "My Favorites" view.
#[tauri::command]
pub async fn set_track_favorite(
    track_id: i64,
    favorite: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        db::set_track_favorite(&conn, track_id, favorite)
    })
    .await
    .map_err(|e| AppError::Other(format!("favorite task failed: {e}")))?
}

/// Publish the current track + play state to the OS Now Playing surface
/// (macOS Control Center / media keys / lock screen). No-op off macOS.
#[tauri::command]
pub fn set_now_playing(app: AppHandle, meta: crate::now_playing::NowPlayingMeta) {
    crate::now_playing::update(&app, meta);
}

/// Remove a track from the library (and any playlists). The audio file on disk
/// is left untouched.
#[tauri::command]
pub async fn delete_track(track_id: i64, state: State<'_, AppState>) -> AppResult<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        db::delete_track(&conn, track_id)
    })
    .await
    .map_err(|e| AppError::Other(format!("delete task failed: {e}")))?
}

/// Remove several tracks from the library in one batch (single transaction).
/// The audio files on disk are left untouched. Returns the number deleted.
#[tauri::command]
pub async fn delete_tracks(track_ids: Vec<i64>, state: State<'_, AppState>) -> AppResult<usize> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        db::delete_tracks(&conn, &track_ids)
    })
    .await
    .map_err(|e| AppError::Other(format!("bulk delete task failed: {e}")))?
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

/// Record a user-initiated play for tracks that are rendered in the webview
/// (YouTube/radio/direct streams). OWNED tracks record inside `load_track`,
/// after the decoder accepts the file.
#[tauri::command]
pub async fn record_play(track_id: i64, state: State<'_, AppState>) -> AppResult<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let played_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = lock_unpoisoned(&db);
        db::record_play(&conn, track_id, played_at)
    })
    .await
    .map_err(|e| AppError::Other(format!("record play task failed: {e}")))?
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

/// Software input gain (0..40 dB) for the line-in monitor + recording — lifts a
/// quiet/phono-level source without leaving the app.
#[tauri::command]
pub fn set_input_gain(db: f32, state: State<'_, AppState>) -> EngineStatus {
    state.engine.set_input_gain(db);
    state.engine.status()
}

/// Turn the visualizer audio tap on/off (the meter thread emits `audio-spectrum`
/// while on, so OWNED/line-in audio can be visualized).
#[tauri::command]
pub fn set_visualizer(active: bool, state: State<'_, AppState>) {
    state.engine.set_visualizer(active);
}

/// Capture a system-audio loopback device (e.g. BlackHole) for the visualizer —
/// emits `audio-spectrum` so YouTube and anything else on the machine can be
/// visualized. No monitor/playback, so there's no echo.
#[tauri::command]
pub async fn start_viz_capture(
    device: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    // Setup blocks briefly (device open + a bounded wait); run it off the main
    // thread so the UI doesn't freeze while the capture comes up.
    let capture = tauri::async_runtime::spawn_blocking(move || {
        crate::audio::viz_capture::start(device, app)
    })
    .await
    .map_err(|e| AppError::Other(format!("viz-capture setup task failed: {e}")))?
    .map_err(AppError::Other)?;
    // Dropping the previous session (if any) stops + joins its thread.
    *lock_unpoisoned(&state.viz_capture) = Some(capture);
    Ok(())
}

/// Stop any active visualizer system-audio capture.
#[tauri::command]
pub fn stop_viz_capture(state: State<'_, AppState>) {
    *lock_unpoisoned(&state.viz_capture) = None;
}

/// Ids of local-file tracks whose file is no longer on disk (moved/ejected) —
/// the library flags these so the user can relink them.
#[tauri::command]
pub async fn check_missing_files(state: State<'_, AppState>) -> AppResult<Vec<i64>> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        let locals = db::local_track_uris(&conn)?;
        Ok(locals
            .into_iter()
            .filter(|(_, uri)| !std::path::Path::new(uri).exists())
            .map(|(id, _)| id)
            .collect())
    })
    .await
    .map_err(|e| AppError::Other(format!("missing-file scan failed: {e}")))?
}

/// Repoint a track to a relocated file the user picked.
#[tauri::command]
pub async fn relink_track(
    track_id: i64,
    new_path: String,
    state: State<'_, AppState>,
) -> AppResult<Track> {
    if !std::path::Path::new(&new_path).exists() {
        return Err(AppError::Other("that file doesn't exist".into()));
    }
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        db::set_track_uri(&conn, track_id, &new_path).map_err(|e| {
            // A UNIQUE(uri) clash means another library row already points there.
            if e.to_string().contains("UNIQUE") {
                AppError::Other("that file is already in your library".into())
            } else {
                e
            }
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("relink task failed: {e}")))?
}

/// Start no-install system-audio capture via ScreenCaptureKit (macOS 13+) so the
/// visualizer can show YouTube without a virtual driver. Surfaces the
/// permission error if Screen Recording isn't granted.
#[tauri::command]
pub async fn start_screen_audio(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    // ScreenCaptureKit setup waits up to ~5s for permission/first frame; run it
    // off the main thread so the UI doesn't freeze during setup.
    let capture = tauri::async_runtime::spawn_blocking(move || {
        crate::audio::screen_audio::start(app)
    })
    .await
    .map_err(|e| AppError::Other(format!("screen-audio setup task failed: {e}")))?
    .map_err(AppError::Other)?;
    *lock_unpoisoned(&state.screen_audio) = Some(capture);
    Ok(())
}

/// Stop any active ScreenCaptureKit system-audio capture.
#[tauri::command]
pub fn stop_screen_audio(state: State<'_, AppState>) {
    *lock_unpoisoned(&state.screen_audio) = None;
}

/// Geometry for one of the three player sizes: `(width, height, min width,
/// min height, floating)`. A floating size is its own minimum so the window
/// can shrink below the full-app floor; only "full" is resizable and normally
/// stacked. Anything unrecognised falls back to the full window.
fn window_geometry(size: &str) -> (f64, f64, f64, f64, bool) {
    match size {
        "micro" => (360.0, 190.0, 360.0, 190.0, true),
        "mini" => (360.0, 600.0, 360.0, 600.0, true),
        _ => (1280.0, 800.0, 1080.0, 720.0, false),
    }
}

/// Size the main window for one of the three player sizes: the full app, the
/// floating "mini" card, or the super-compact "micro" bar (title + transport +
/// sliders). Mini and micro are fixed-size and always-on-top; only the in-app
/// grow button steps back up.
#[tauri::command]
pub fn set_window_size(size: String, app: AppHandle) -> AppResult<()> {
    use tauri::{LogicalSize, Size};
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::Other("main window not found".into()))?;
    let map = |r: Result<(), tauri::Error>| r.map_err(|e| AppError::Other(e.to_string()));
    let (w, h, min_w, min_h, floating) = window_geometry(&size);

    // Unlock first: a non-resizable window ignores programmatic resizes on
    // macOS, so mini → micro would otherwise stay stuck at the mini size.
    // Likewise lower the minimum before shrinking, or the new size is clamped.
    map(win.set_resizable(true))?;
    map(win.set_min_size(Some(Size::Logical(LogicalSize::new(min_w, min_h)))))?;
    map(win.set_size(Size::Logical(LogicalSize::new(w, h))))?;
    if floating {
        map(win.set_resizable(false))?;
    }
    let _ = win.set_always_on_top(floating);
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::window_geometry;

    /// Every floating size must be its own minimum, or macOS clamps the
    /// shrink and the window stays at the size it already had.
    #[test]
    fn floating_player_sizes_are_their_own_minimum() {
        for size in ["mini", "micro"] {
            let (w, h, min_w, min_h, floating) = window_geometry(size);
            assert!(floating, "{size} should float above other windows");
            assert_eq!((w, h), (min_w, min_h), "{size} must be able to reach its size");
        }
    }

    /// Micro is the smallest size, and unknown values fall back to the full
    /// window rather than trapping the user in a locked, tiny window.
    #[test]
    fn micro_is_smallest_and_unknown_falls_back_to_full() {
        let (_, micro_h, ..) = window_geometry("micro");
        let (_, mini_h, ..) = window_geometry("mini");
        assert!(micro_h < mini_h, "micro must be shorter than mini");

        let full = window_geometry("full");
        assert_eq!(window_geometry("nonsense"), full);
        assert!(!full.4, "the full window stays resizable");
    }
}
