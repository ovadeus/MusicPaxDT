//! Stream-lane commands: YouTube URL import, the Mirror Engine (Spotify
//! playlist / pasted list → official YouTube embeds), playlist building, and
//! integration credentials (OS keychain — never plaintext).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::ai::PLAYLIST_MAX_TRACKS;
use crate::commands::enrich::resolve_llm;
use crate::error::{AppError, AppResult};
use crate::library::db;
use crate::library::model::{Capability, NewTrack, PlaylistInfo, Track};
use crate::net::{http, keyring_get, keyring_set};
use crate::sources::radio::{self, RadioStation};
use crate::sources::spotify::ListedTrack;
use crate::sources::{detect, spotify, youtube, DetectedInput};
use crate::state::{lock_unpoisoned, AppState};

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Integration credentials
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub youtube_api_key: bool,
    pub spotify_credentials: bool,
}

#[tauri::command]
pub fn integration_status() -> IntegrationStatus {
    IntegrationStatus {
        youtube_api_key: keyring_get("youtube_api_key").is_some(),
        spotify_credentials: keyring_get("spotify_client_id").is_some()
            && keyring_get("spotify_client_secret").is_some(),
    }
}

#[tauri::command]
pub fn set_youtube_api_key(key: String) -> AppResult<()> {
    keyring_set("youtube_api_key", key.trim()).map_err(AppError::Other)
}

/// One page of the MusicPax public feed (musicpax.com). Read-only metadata for
/// the in-app "MusicPax Feed" view; infinite scroll drives `page`.
#[tauri::command]
pub async fn musicpax_feed(
    page: u32,
    limit: u32,
    category: Option<String>,
) -> AppResult<crate::sources::musicpax_feed::FeedPage> {
    crate::sources::musicpax_feed::fetch(page, limit, category.as_deref()).await
}

#[tauri::command]
pub fn set_spotify_credentials(client_id: String, client_secret: String) -> AppResult<()> {
    keyring_set("spotify_client_id", client_id.trim()).map_err(AppError::Other)?;
    keyring_set("spotify_client_secret", client_secret.trim()).map_err(AppError::Other)
}

// ---------------------------------------------------------------------------
// Internet radio (Radio Browser) — browse, search, add to library
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtSearchResult {
    pub video_id: String,
    pub title: String,
    pub channel: String,
    pub duration_ms: Option<u64>,
    pub published: Option<String>,
    pub url: String,
}

/// Search YouTube for videos. Uses the user's Data API key when configured,
/// otherwise the keyless web fallback. `sort` is one of relevance|date|views|
/// rating. Results are STREAM_PLAYABLE candidates.
#[tauri::command]
pub async fn youtube_search(
    query: String,
    sort: Option<String>,
) -> AppResult<Vec<YtSearchResult>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let order = youtube::SortOrder::parse(sort.as_deref());
    let candidates = match keyring_get("youtube_api_key") {
        Some(key) => youtube::search(http(), &key, q, 40, order).await,
        None => youtube::search_keyless(http(), q, order).await,
    }
    .map_err(AppError::Other)?;
    Ok(candidates
        .into_iter()
        .map(|c| YtSearchResult {
            url: youtube::watch_url(&c.video_id),
            video_id: c.video_id,
            title: c.title,
            channel: c.channel,
            duration_ms: c.duration_ms,
            published: c.published,
        })
        .collect())
}

#[tauri::command]
pub async fn radio_top(limit: Option<u32>) -> AppResult<Vec<RadioStation>> {
    radio::top(limit.unwrap_or(60)).await.map_err(AppError::Other)
}

#[tauri::command]
pub async fn radio_search(query: String, limit: Option<u32>) -> AppResult<Vec<RadioStation>> {
    radio::search(&query, limit.unwrap_or(60))
        .await
        .map_err(AppError::Other)
}

/// Resolve a pasted link (player page, playlist, or direct URL) into a
/// playable station. Best effort — returns a clear error if no stream is found.
#[tauri::command]
pub async fn resolve_radio_stream(url: String) -> AppResult<RadioStation> {
    radio::resolve_stream(&url).await.map_err(AppError::Other)
}

/// Save a station as a STREAM_PLAYABLE library track (source_kind = "radio").
#[tauri::command]
pub async fn import_radio_station(
    name: String,
    url: String,
    favicon: Option<String>,
    tags: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Track> {
    let new_track = NewTrack {
        title: Some(name),
        artist: Some("Radio".into()),
        album: None,
        year: None,
        genre: tags,
        duration_ms: None,
        uri: url,
        source_kind: "radio".into(),
        capability: Capability::StreamPlayable,
    };
    let _ = favicon; // (art handling for radio favicons can come later)
    insert_stream_track(&state, &new_track)
}

// ---------------------------------------------------------------------------
// Single URL import
// ---------------------------------------------------------------------------

fn insert_stream_track(
    state: &State<'_, AppState>,
    new_track: &NewTrack,
) -> AppResult<Track> {
    let conn = lock_unpoisoned(&state.db);
    db::insert_track(&conn, new_track, now_unix())?;
    db::get_track_by_uri(&conn, &new_track.uri)?
        .ok_or_else(|| AppError::Other("stream track vanished after insert".into()))
}

/// Import a single YouTube URL as a STREAM_PLAYABLE library entry. Plays via
/// the official IFrame embed only — the audio engine will refuse it by design.
#[tauri::command]
pub async fn import_stream_url(url: String, state: State<'_, AppState>) -> AppResult<Track> {
    match detect(&url) {
        DetectedInput::YouTubeVideo(id) => {
            let meta = youtube::oembed(http(), &id)
                .await
                .map_err(AppError::Other)?;
            let new_track = NewTrack {
                title: Some(meta.title),
                artist: Some(meta.author_name),
                album: None,
                year: None,
                genre: None,
                duration_ms: None,
                uri: youtube::watch_url(&id),
                source_kind: "youtube".into(),
                capability: Capability::StreamPlayable,
            };
            insert_stream_track(&state, &new_track)
        }
        DetectedInput::SpotifyPlaylist(_) => Err(AppError::Other(
            "that's a Spotify playlist — use Mirror to convert it to YouTube streams".into(),
        )),
        _ => Err(AppError::Other(
            "unrecognized URL — paste a YouTube video link".into(),
        )),
    }
}

// ---------------------------------------------------------------------------
// Direct stream URLs (Archive.org & friends) — any direct audio/video file.
// ---------------------------------------------------------------------------

const AUDIO_EXTS: &[&str] = &[
    "mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "aiff", "aif", "wma",
];
const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "webm", "mov", "mkv", "avi", "ogv"];

/// Minimal percent-decoding for turning a URL filename into a readable title.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // Only treat "%XY" as an escape when X and Y are ASCII hex digits. That
        // guard also keeps the slice on a char boundary: a multibyte UTF-8 byte
        // after '%' (e.g. "%aé") would otherwise panic on `&s[i + 1..i + 3]`.
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn url_path(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or(url)
}

/// "audio" / "video" by file extension, or None when unknown.
fn media_kind_by_ext(url: &str) -> Option<&'static str> {
    let ext = url_path(url).rsplit('.').next().unwrap_or("").to_lowercase();
    if AUDIO_EXTS.contains(&ext.as_str()) {
        Some("audio")
    } else if VIDEO_EXTS.contains(&ext.as_str()) {
        Some("video")
    } else {
        None
    }
}

/// Readable title from the URL's last path segment (percent-decoded, no ext).
fn title_from_url(url: &str) -> String {
    let seg = url_path(url).rsplit('/').next().unwrap_or("");
    let decoded = percent_decode(seg);
    match decoded.rsplit_once('.') {
        Some((stem, ext)) if (AUDIO_EXTS.contains(&ext.to_lowercase().as_str())
            || VIDEO_EXTS.contains(&ext.to_lowercase().as_str())) =>
        {
            stem.to_string()
        }
        _ => decoded,
    }
    .trim()
    .to_string()
}

/// Best-effort content-type probe for URLs without a media extension.
async fn probe_media_type(url: &str) -> Option<&'static str> {
    let resp = http().head(url).send().await.ok()?;
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .to_lowercase();
    if ct.starts_with("audio/") {
        Some("audio")
    } else if ct.starts_with("video/") {
        Some("video")
    } else {
        None
    }
}

/// Import a direct audio/video URL (e.g. an Archive.org file) as a
/// STREAM_PLAYABLE library entry that plays inline via the webview — never
/// decoded by the OWNED engine, so no DSP/recording (matches the radio lane).
#[tauri::command]
pub async fn import_direct_stream(url: String, state: State<'_, AppState>) -> AppResult<Track> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::Other(
            "Enter a direct http(s) link to an audio or video file".into(),
        ));
    }
    // Validate it's a media file: by extension first (no network), else probe.
    if media_kind_by_ext(&url).is_none() && probe_media_type(&url).await.is_none() {
        return Err(AppError::Other(
            "That doesn't look like a direct audio/video file (mp3, mp4, ogg, wav, …)".into(),
        ));
    }
    let title = title_from_url(&url);
    let new_track = NewTrack {
        title: Some(if title.is_empty() { "Stream".into() } else { title }),
        artist: None,
        album: None,
        year: None,
        genre: None,
        duration_ms: None,
        uri: url,
        source_kind: "stream".into(),
        capability: Capability::StreamPlayable,
    };
    insert_stream_track(&state, &new_track)
}

// ---------------------------------------------------------------------------
// Mirror Engine v1 (heuristic matching; LLM ranking arrives with M5)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorReport {
    pub playlist_id: i64,
    pub playlist_name: String,
    pub total: usize,
    pub matched: usize,
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MirrorProgress {
    done: usize,
    total: usize,
    matched: usize,
    current: String,
}

async fn search_candidates(query: &str) -> Result<Vec<youtube::Candidate>, String> {
    // Official Data API when the user configured a key (most stable),
    // keyless web search otherwise (works out of the box).
    match keyring_get("youtube_api_key") {
        // Pull a wider result set (20, not 6) so the official "- Topic"/artist
        // upload is actually present for best_match to prefer — relevance
        // ordering frequently ranks obscure re-uploads above it.
        Some(key) => youtube::search(http(), &key, query, 20, youtube::SortOrder::Relevance).await,
        None => youtube::search_keyless(http(), query, youtube::SortOrder::Relevance).await,
    }
}

/// Convert a Spotify playlist URL or a pasted "Artist - Title"/CSV list into
/// a STACK playlist of STREAM_PLAYABLE YouTube entries.
#[tauri::command]
pub async fn mirror_playlist(
    input: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<MirrorReport> {
    let (name, wanted) = match detect(&input) {
        DetectedInput::SpotifyPlaylist(id) => {
            // Official API when credentials exist (no track cap); otherwise
            // read the public playlist page directly — no account needed,
            // it's only a track-list reference.
            let client_id = keyring_get("spotify_client_id");
            let client_secret = keyring_get("spotify_client_secret");
            if let (Some(client_id), Some(client_secret)) = (client_id, client_secret) {
                let token = spotify::access_token(http(), &client_id, &client_secret)
                    .await
                    .map_err(AppError::Other)?;
                spotify::playlist_tracks(http(), &token, &id)
                    .await
                    .map_err(AppError::Other)?
            } else {
                spotify::playlist_tracks_public(http(), &id)
                    .await
                    .map_err(AppError::Other)?
            }
        }
        DetectedInput::TextList => {
            let list = spotify::parse_text_list(&input);
            (format!("Imported list ({} tracks)", list.len()), list)
        }
        DetectedInput::YouTubeVideo(_) => {
            return Err(AppError::Other(
                "that's a single YouTube video — use Add URL instead".into(),
            ));
        }
        DetectedInput::Unknown => {
            return Err(AppError::Other(
                "paste a Spotify playlist URL or an Artist - Title list".into(),
            ));
        }
    };

    if wanted.is_empty() {
        return Err(AppError::Other("no tracks found in that input".into()));
    }

    mirror_listed_tracks(name, wanted, &app, &state).await
}

/// Default track count for an AI-built playlist when the UI sends none.
const AI_PLAYLIST_DEFAULT_TRACKS: usize = 25;

/// AI front door to the Mirror Engine: the configured LLM drafts an
/// `Artist - Title` list from a natural-language request, then it is mirrored
/// exactly like a pasted list — same YouTube search, same channel-authority
/// ranking (Topic / official artist / VEVO first), same `mirror-progress`
/// events. The LLM only names songs; it never touches audio (hard rule 2).
#[tauri::command]
pub async fn ai_build_playlist(
    prompt: String,
    count: Option<usize>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<MirrorReport> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(AppError::Other("describe the playlist you want".into()));
    }
    let count = count
        .unwrap_or(AI_PLAYLIST_DEFAULT_TRACKS)
        .clamp(1, PLAYLIST_MAX_TRACKS);

    let db = state.db.clone();
    let provider = tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        resolve_llm(&conn)
    })
    .await
    .map_err(|e| AppError::Other(format!("load task failed: {e}")))??
    .ok_or_else(|| {
        AppError::Other(
            "No AI provider configured — add an API key or Ollama in Settings → Integrations."
                .into(),
        )
    })?;

    let draft = provider
        .suggest_playlist(&prompt, count)
        .await
        .map_err(AppError::Other)?;
    if draft.tracks.is_empty() {
        return Err(AppError::Other(
            "the AI didn't return any tracks — try rephrasing your request".into(),
        ));
    }

    let name = draft
        .name
        .unwrap_or_else(|| playlist_name_from_prompt(&prompt));
    let wanted: Vec<ListedTrack> = draft
        .tracks
        .into_iter()
        .map(|t| ListedTrack {
            title: t.title,
            artist: t.artist,
            duration_ms: None,
        })
        .collect();
    mirror_listed_tracks(name, wanted, &app, &state).await
}

/// Fallback playlist name when the curator omits one: the request itself,
/// collapsed to one line and trimmed to a sidebar-friendly length.
fn playlist_name_from_prompt(prompt: &str) -> String {
    const MAX_CHARS: usize = 60;
    let one_line = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= MAX_CHARS {
        return one_line;
    }
    let cut: String = one_line.chars().take(MAX_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Resolve each wanted track to an official YouTube embed and file the matches
/// in a new playlist, emitting `mirror-progress` as it goes. Shared by the
/// Spotify / pasted-list mirror and the AI playlist builder so both lanes get
/// identical matching.
async fn mirror_listed_tracks(
    name: String,
    wanted: Vec<ListedTrack>,
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> AppResult<MirrorReport> {
    let playlist_id = {
        let conn = lock_unpoisoned(&state.db);
        db::create_playlist(&conn, &name)?
    };

    let total = wanted.len();
    let mut matched = 0usize;
    let mut failed = Vec::new();

    for (i, want) in wanted.iter().enumerate() {
        let query = if want.artist.is_empty() {
            want.title.clone()
        } else {
            format!("{} {}", want.artist, want.title)
        };
        let _ = app.emit(
            "mirror-progress",
            MirrorProgress {
                done: i,
                total,
                matched,
                current: query.clone(),
            },
        );

        match search_candidates(&query).await {
            Ok(candidates) => {
                match youtube::best_match(&want.artist, &want.title, want.duration_ms, &candidates)
                {
                    Some((best, _score)) => {
                        let new_track = NewTrack {
                            title: Some(want.title.clone()),
                            artist: (!want.artist.is_empty()).then(|| want.artist.clone()),
                            album: None,
                            year: None,
                            genre: None,
                            duration_ms: best.duration_ms.map(|d| d as i64),
                            uri: youtube::watch_url(&best.video_id),
                            source_kind: "youtube".into(),
                            capability: Capability::StreamPlayable,
                        };
                        let conn = lock_unpoisoned(&state.db);
                        db::insert_track(&conn, &new_track, now_unix())?;
                        if let Some(track) = db::get_track_by_uri(&conn, &new_track.uri)? {
                            db::add_to_playlist(&conn, playlist_id, track.id)?;
                            matched += 1;
                        }
                    }
                    None => failed.push(query),
                }
            }
            Err(e) => failed.push(format!("{query} ({e})")),
        }
        // Be polite to the search endpoint.
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    let _ = app.emit(
        "mirror-progress",
        MirrorProgress {
            done: total,
            total,
            matched,
            current: String::new(),
        },
    );

    Ok(MirrorReport {
        playlist_id,
        playlist_name: name,
        total,
        matched,
        failed,
    })
}

// ---------------------------------------------------------------------------
// Self-healing library: find dead YouTube streams and re-resolve them.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairReport {
    /// STREAM_PLAYABLE YouTube tracks health-checked.
    pub checked: usize,
    /// Found unavailable (removed / private, per oEmbed).
    pub dead: usize,
    /// Successfully re-pointed to a working replacement video.
    pub healed: usize,
    /// Dead but no confident replacement was found.
    pub still_dead: usize,
    /// Titles that were healed (for a friendly summary).
    pub healed_titles: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepairProgress {
    /// "checking" while probing health, "repairing" while re-resolving.
    phase: String,
    done: usize,
    total: usize,
    healed: usize,
}

/// Scan every STREAM_PLAYABLE YouTube track, detect the ones that no longer
/// play (removed/private — probed for free via oEmbed, in parallel), and
/// re-resolve each through the Mirror Engine (search → best_match) to a working
/// replacement video. Emits `repair-progress`. This is the "self-healing
/// library" pass: a playlist you built years ago keeps playing.
#[tauri::command]
pub async fn repair_streams(app: AppHandle, state: State<'_, AppState>) -> AppResult<RepairReport> {
    let tracks = {
        let conn = lock_unpoisoned(&state.db);
        db::tracks_by_source_kind(&conn, "youtube")?
    };
    let checked = tracks.len();

    // Phase 1 — health-check concurrently (bounded). oEmbed 4xx == unavailable.
    const CONCURRENCY: usize = 8;
    let mut dead: Vec<Track> = Vec::new();
    let mut done = 0usize;
    for chunk in tracks.chunks(CONCURRENCY) {
        let mut handles = Vec::with_capacity(chunk.len());
        for t in chunk {
            let client = http().clone();
            let vid = youtube::parse_video_id(&t.uri);
            handles.push((t.clone(), tauri::async_runtime::spawn(async move {
                match vid {
                    // An oEmbed error (404/401/etc.) means the video is gone.
                    Some(v) => youtube::oembed(&client, &v).await.is_err(),
                    None => false,
                }
            })));
        }
        for (t, h) in handles {
            done += 1;
            if h.await.unwrap_or(false) {
                dead.push(t);
            }
        }
        let _ = app.emit(
            "repair-progress",
            RepairProgress {
                phase: "checking".into(),
                done,
                total: checked,
                healed: 0,
            },
        );
    }

    // Phase 2 — re-resolve the dead ones (sequential: rate-limited search + DB).
    let dead_count = dead.len();
    let mut healed = 0usize;
    let mut healed_titles = Vec::new();
    for (i, t) in dead.iter().enumerate() {
        let title = t.title.clone().unwrap_or_default();
        let artist = t.artist.clone().unwrap_or_default();
        let query = if artist.is_empty() {
            title.clone()
        } else {
            format!("{artist} {title}")
        };
        let _ = app.emit(
            "repair-progress",
            RepairProgress {
                phase: "repairing".into(),
                done: i,
                total: dead_count,
                healed,
            },
        );
        if let Ok(candidates) = search_candidates(&query).await {
            let want_ms = t.duration_ms.map(|d| d as u64);
            if let Some((best, _score)) = youtube::best_match(&artist, &title, want_ms, &candidates) {
                let old_id = youtube::parse_video_id(&t.uri);
                // Only heal to a *different* video; the same id would still be dead.
                if old_id.as_deref() != Some(best.video_id.as_str()) {
                    let new_uri = youtube::watch_url(&best.video_id);
                    let conn = lock_unpoisoned(&state.db);
                    db::set_track_uri(&conn, t.id, &new_uri)?;
                    // New video → drop the stale cached thumbnail (art derives from uri).
                    db::clear_track_art_path(&conn, t.id)?;
                    drop(conn);
                    healed += 1;
                    healed_titles.push(if title.is_empty() { query.clone() } else { title });
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    let _ = app.emit(
        "repair-progress",
        RepairProgress {
            phase: "repairing".into(),
            done: dead_count,
            total: dead_count,
            healed,
        },
    );

    Ok(RepairReport {
        checked,
        dead: dead_count,
        healed,
        still_dead: dead_count - healed,
        healed_titles,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReResolveResult {
    pub healed: bool,
    pub new_uri: Option<String>,
    pub message: String,
}

/// Re-resolve a single YouTube track to a working replacement (used for
/// auto-heal the moment the embed reports a video is unplayable). Unlike the
/// batch pass this skips the oEmbed probe — the caller already knows it failed.
#[tauri::command]
pub async fn reresolve_stream(
    track_id: i64,
    state: State<'_, AppState>,
) -> AppResult<ReResolveResult> {
    let track = {
        let conn = lock_unpoisoned(&state.db);
        db::get_track(&conn, track_id)?
    };
    if track.source_kind != "youtube" {
        return Ok(ReResolveResult {
            healed: false,
            new_uri: None,
            message: "Only YouTube tracks can be re-resolved".into(),
        });
    }
    let title = track.title.clone().unwrap_or_default();
    let artist = track.artist.clone().unwrap_or_default();
    let query = if artist.is_empty() {
        title.clone()
    } else {
        format!("{artist} {title}")
    };
    if query.trim().is_empty() {
        return Ok(ReResolveResult {
            healed: false,
            new_uri: None,
            message: "No title to search for a replacement".into(),
        });
    }
    let candidates = search_candidates(&query).await.map_err(AppError::Other)?;
    let want_ms = track.duration_ms.map(|d| d as u64);
    match youtube::best_match(&artist, &title, want_ms, &candidates) {
        Some((best, _score))
            if youtube::parse_video_id(&track.uri).as_deref() != Some(best.video_id.as_str()) =>
        {
            let new_uri = youtube::watch_url(&best.video_id);
            let conn = lock_unpoisoned(&state.db);
            db::set_track_uri(&conn, track_id, &new_uri)?;
            db::clear_track_art_path(&conn, track_id)?;
            Ok(ReResolveResult {
                healed: true,
                new_uri: Some(new_uri),
                message: format!("Re-resolved “{title}”"),
            })
        }
        _ => Ok(ReResolveResult {
            healed: false,
            new_uri: None,
            message: "No working replacement found".into(),
        }),
    }
}

// ---------------------------------------------------------------------------
// .mpx import (MusicPax playlist export)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpxImportReport {
    pub playlist_id: i64,
    pub playlist_name: String,
    pub imported: usize,
    pub skipped: usize,
    pub duplicates: usize,
    pub warnings: Vec<String>,
}

/// Map a MusicPax sourceType onto our capability model + source_kind.
/// YouTube is the first-class playable lane; direct-stream types stay
/// STREAM_PLAYABLE; SoundCloud/Spotify can't play inline so they're LINK_ONLY.
fn capability_for(source_type: Option<&str>) -> (Capability, String) {
    match source_type.unwrap_or("") {
        "youtube" => (Capability::StreamPlayable, "youtube".into()),
        "spotify" | "soundcloud" => (Capability::LinkOnly, source_type.unwrap().into()),
        "" => (Capability::StreamPlayable, "stream".into()),
        other => (Capability::StreamPlayable, other.into()),
    }
}

/// Import a MusicPax `.mpx` playlist file (plain JSON; legacy encrypted is
/// reported, not parsed). Creates a new playlist and adds each track; tracks
/// with no usable URL are skipped, and the same URL is added to the playlist
/// only once (de-duped within the import).
#[tauri::command]
pub async fn import_mpx_playlist(
    path: String,
    state: State<'_, AppState>,
) -> AppResult<MpxImportReport> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path)
            .map_err(|e| AppError::Other(format!("cannot read {path}: {e}")))?;
        let parsed = crate::sources::mpx::parse_mpx(&bytes).map_err(AppError::Other)?;

        let conn = lock_unpoisoned(&db);
        let playlist_id = db::create_playlist(&conn, &parsed.name)?;

        let mut imported = 0usize;
        let mut skipped = 0usize;
        let mut duplicates = 0usize;
        let mut seen = std::collections::HashSet::new();
        let added_at = now_unix();

        for t in &parsed.tracks {
            let Some(url) = t.url.clone() else {
                skipped += 1;
                continue;
            };
            if !seen.insert(url.clone()) {
                duplicates += 1;
                continue;
            }
            let (capability, source_kind) = capability_for(t.source_type.as_deref());
            let new_track = NewTrack {
                title: t.title.clone(),
                artist: t.artist.clone(),
                album: t.album.clone(),
                year: t.year,
                genre: t.category.clone(),
                duration_ms: t.duration_ms,
                uri: url.clone(),
                source_kind,
                capability,
            };
            // Insert (dedupes existing library rows by uri), then attach the
            // resulting track to the new playlist.
            db::insert_track(&conn, &new_track, added_at)?;
            if let Some(track) = db::get_track_by_uri(&conn, &url)? {
                if let Some(cover) = &t.cover {
                    let _ = db::set_track_art_path(&conn, track.id, cover);
                }
                db::add_to_playlist(&conn, playlist_id, track.id)?;
                imported += 1;
            } else {
                skipped += 1;
            }
        }

        let mut warnings = parsed.warnings;
        if duplicates > 0 {
            warnings.push(format!("{duplicates} duplicate URL(s) collapsed"));
        }

        Ok(MpxImportReport {
            playlist_id,
            playlist_name: parsed.name,
            imported,
            skipped,
            duplicates,
            warnings,
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("mpx import task failed: {e}")))?
}

// ---------------------------------------------------------------------------
// Playlists (the building layer)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_playlists(state: State<'_, AppState>) -> AppResult<Vec<PlaylistInfo>> {
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::list_playlists(&conn)
    })
    .await
    .map_err(|e| AppError::Other(format!("playlist task failed: {e}")))?
}

#[tauri::command]
pub async fn create_playlist(name: String, state: State<'_, AppState>) -> AppResult<i64> {
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::create_playlist(&conn, name.trim())
    })
    .await
    .map_err(|e| AppError::Other(format!("playlist task failed: {e}")))?
}

#[tauri::command]
pub async fn playlist_tracks(
    playlist_id: i64,
    state: State<'_, AppState>,
) -> AppResult<Vec<Track>> {
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::playlist_tracks(&conn, playlist_id)
    })
    .await
    .map_err(|e| AppError::Other(format!("playlist task failed: {e}")))?
}

/// Persist a drag-and-drop playlist order (sidebar ids in display order).
#[tauri::command]
pub async fn reorder_playlists(ids: Vec<i64>, state: State<'_, AppState>) -> AppResult<()> {
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::reorder_playlists(&conn, &ids)
    })
    .await
    .map_err(|e| AppError::Other(format!("reorder task failed: {e}")))?
}

// ---------------------------------------------------------------------------
// Playlist folders (sidebar grouping)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_playlist_folders(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::library::model::FolderInfo>> {
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::list_folders(&conn)
    })
    .await
    .map_err(|e| AppError::Other(format!("folders task failed: {e}")))?
}

#[tauri::command]
pub async fn create_playlist_folder(name: String, state: State<'_, AppState>) -> AppResult<i64> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Other("Folder name can't be empty".into()));
    }
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::create_folder(&conn, &trimmed)
    })
    .await
    .map_err(|e| AppError::Other(format!("create-folder task failed: {e}")))?
}

#[tauri::command]
pub async fn rename_playlist_folder(
    folder_id: i64,
    name: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Other("Folder name can't be empty".into()));
    }
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::rename_folder(&conn, folder_id, &trimmed)
    })
    .await
    .map_err(|e| AppError::Other(format!("rename-folder task failed: {e}")))?
}

/// Delete a folder: its playlists move back to the sidebar root (never deleted).
#[tauri::command]
pub async fn delete_playlist_folder(folder_id: i64, state: State<'_, AppState>) -> AppResult<()> {
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::delete_folder(&conn, folder_id)
    })
    .await
    .map_err(|e| AppError::Other(format!("delete-folder task failed: {e}")))?
}

#[tauri::command]
pub async fn set_folder_collapsed(
    folder_id: i64,
    collapsed: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::set_folder_collapsed(&conn, folder_id, collapsed)
    })
    .await
    .map_err(|e| AppError::Other(format!("collapse task failed: {e}")))?
}

#[tauri::command]
pub async fn move_playlist_to_folder(
    playlist_id: i64,
    folder_id: Option<i64>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::move_playlist_to_folder(&conn, playlist_id, folder_id)
    })
    .await
    .map_err(|e| AppError::Other(format!("move-to-folder task failed: {e}")))?
}

#[tauri::command]
pub async fn reorder_playlist_folders(ids: Vec<i64>, state: State<'_, AppState>) -> AppResult<()> {
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::reorder_folders(&conn, &ids)
    })
    .await
    .map_err(|e| AppError::Other(format!("reorder-folders task failed: {e}")))?
}

#[tauri::command]
pub async fn add_to_playlist(
    playlist_id: i64,
    track_id: i64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::add_to_playlist(&conn, playlist_id, track_id)
    })
    .await
    .map_err(|e| AppError::Other(format!("playlist task failed: {e}")))?
}

#[tauri::command]
pub async fn delete_playlist(playlist_id: i64, state: State<'_, AppState>) -> AppResult<()> {
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::delete_playlist(&conn, playlist_id)
    })
    .await
    .map_err(|e| AppError::Other(format!("playlist task failed: {e}")))?
}

#[tauri::command]
pub async fn rename_playlist(
    playlist_id: i64,
    name: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Other("Playlist name can't be empty".into()));
    }
    let db_arc = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db_arc);
        db::rename_playlist(&conn, playlist_id, &trimmed)
    })
    .await
    .map_err(|e| AppError::Other(format!("playlist task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_title_from_archive_org_url() {
        let url = "https://archive.org/download/the-shadow-radio-show-1937-1954-old-time-radio-all-available-episodes/1937-09-26%20-%20Death%20House%20Rescue.mp3";
        assert_eq!(title_from_url(url), "1937-09-26 - Death House Rescue");
        assert_eq!(media_kind_by_ext(url), Some("audio"));
    }

    #[test]
    fn detects_video_and_unknown_extensions() {
        assert_eq!(media_kind_by_ext("https://x.com/clip.mp4"), Some("video"));
        assert_eq!(media_kind_by_ext("https://x.com/song.OGG?x=1"), Some("audio"));
        assert_eq!(media_kind_by_ext("https://x.com/page.html"), None);
    }

    #[test]
    fn percent_decoding_handles_spaces_and_specials() {
        assert_eq!(percent_decode("a%20b%2Dc"), "a b-c");
        assert_eq!(percent_decode("plus+space"), "plus space");
    }

    #[test]
    fn percent_decode_survives_bare_and_multibyte_percent() {
        // A '%' followed by a multibyte UTF-8 byte used to slice mid-char and
        // panic; now it's passed through literally.
        assert_eq!(percent_decode("%aé.mp3"), "%aé.mp3");
        assert_eq!(percent_decode("100% done"), "100% done");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("trailing%"), "trailing%");
        // Valid escapes still decode.
        assert_eq!(percent_decode("%41%42"), "AB");
    }
}
