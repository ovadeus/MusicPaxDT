//! Share-playlist command: serialize a playlist to `.mpx` (references only —
//! never audio) and POST it to the MusicPax share endpoint, which stores it,
//! emails the recipient a link, and serves the landing page. The endpoint base
//! is the `share.api_base` setting (default musicpax.com) so the whole flow is
//! testable against a local server (see handoff/share-server/standalone.js).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::db;
use crate::net::http;
use crate::sources::mpx_export;
use crate::state::{lock_unpoisoned, AppState};

const DEFAULT_API_BASE: &str = "https://musicpax.com";
/// Server enforces the same caps; these just fail fast with a clearer message.
const MAX_TRACKS: usize = 500;
const MAX_BYTES: usize = 1_000_000;

/// What the UI shows after a successful share.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareReport {
    pub share_url: String,
    pub track_count: usize,
    pub excluded_local: usize,
}

#[derive(Deserialize)]
struct ShareResponse {
    #[serde(rename = "shareUrl")]
    share_url: String,
}

#[derive(Deserialize)]
struct ServerError {
    error: Option<ServerErrorBody>,
}
#[derive(Deserialize)]
struct ServerErrorBody {
    message: Option<String>,
}

/// Minimal shape check — the server re-validates properly. Just catches typos
/// before a round-trip.
fn looks_like_email(s: &str) -> bool {
    let s = s.trim();
    let Some((user, host)) = s.split_once('@') else {
        return false;
    };
    !user.is_empty() && host.contains('.') && !host.ends_with('.') && !s.contains(char::is_whitespace)
}

fn host_of(url: &str) -> &str {
    url.trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or(url)
}

#[tauri::command]
pub async fn share_playlist(
    playlist_id: i64,
    recipient_email: String,
    sender_name: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<ShareReport> {
    let recipient = recipient_email.trim().to_string();
    if !looks_like_email(&recipient) {
        return Err(AppError::Other(
            "That doesn't look like an email address — check it and try again.".into(),
        ));
    }

    // Read everything we need from the DB off-thread.
    let db_arc = state.db.clone();
    let (name, tracks, api_base) = tauri::async_runtime::spawn_blocking(
        move || -> AppResult<(String, Vec<crate::library::model::Track>, String)> {
            let conn = lock_unpoisoned(&db_arc);
            let name = db::list_playlists(&conn)?
                .into_iter()
                .find(|p| p.id == playlist_id)
                .map(|p| p.name)
                .ok_or(AppError::Other("playlist not found".into()))?;
            let tracks = db::playlist_tracks(&conn, playlist_id)?;
            let api_base = db::get_setting(&conn, "share.api_base")?
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| DEFAULT_API_BASE.to_string());
            Ok((name, tracks, api_base))
        },
    )
    .await
    .map_err(|e| AppError::Other(format!("share task failed: {e}")))??;

    let (mpx, stats) = mpx_export::export_mpx(&name, Some("Shared from MUSICPAX"), &tracks);
    if stats.included == 0 {
        return Err(AppError::Other(
            "This playlist only contains local files — they stay on your disk, so there's \
             nothing shareable in it. Add streamable tracks (YouTube, radio, streams) to share."
                .into(),
        ));
    }
    if stats.included > MAX_TRACKS {
        return Err(AppError::Other(format!(
            "This playlist is too large to share (limit: {MAX_TRACKS} tracks)."
        )));
    }
    let payload = serde_json::json!({
        "recipientEmail": recipient,
        "senderName": sender_name.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        "playlistName": name,
        "mpx": mpx,
    });
    let body = serde_json::to_vec(&payload)
        .map_err(|e| AppError::Other(format!("could not encode the share payload: {e}")))?;
    if body.len() > MAX_BYTES {
        return Err(AppError::Other(
            "This playlist is too large to share (limit: 1 MB).".into(),
        ));
    }

    let url = format!("{api_base}/api/share");
    let resp = http()
        .post(&url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| {
            AppError::Other(format!(
                "Could not reach {} — check your connection (is the share server running?).",
                host_of(&api_base)
            ))
        })?;

    let status = resp.status();
    if status.as_u16() == 429 {
        let retry = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());
        return Err(AppError::Other(match retry {
            Some(s) => format!("Sharing is rate-limited right now — try again in {s}s."),
            None => "Sharing is rate-limited right now — try again in a bit.".into(),
        }));
    }
    if status.is_client_error() {
        // Surface the server's own message when it sent one.
        let msg = resp
            .json::<ServerError>()
            .await
            .ok()
            .and_then(|e| e.error)
            .and_then(|e| e.message)
            .unwrap_or_else(|| format!("the share was rejected (HTTP {})", status.as_u16()));
        return Err(AppError::Other(msg));
    }
    if !status.is_success() {
        return Err(AppError::Other(format!(
            "{} had a problem (HTTP {}) — try again later.",
            host_of(&api_base),
            status.as_u16()
        )));
    }

    let parsed: ShareResponse = resp.json().await.map_err(|e| {
        AppError::Other(format!("unexpected response from the share server: {e}"))
    })?;
    Ok(ShareReport {
        share_url: parsed.share_url,
        track_count: stats.included,
        excluded_local: stats.excluded_local,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_shape_check() {
        assert!(looks_like_email("a@b.co"));
        assert!(looks_like_email(" friend@mail.example.org "));
        assert!(!looks_like_email("nope"));
        assert!(!looks_like_email("a@b"));
        assert!(!looks_like_email("a@b."));
        assert!(!looks_like_email("a b@c.d"));
        assert!(!looks_like_email("@x.y"));
    }

    #[test]
    fn host_extraction() {
        assert_eq!(host_of("https://musicpax.com"), "musicpax.com");
        assert_eq!(host_of("http://localhost:3001"), "localhost:3001");
    }

    /// Full share loop against the handoff server:
    /// export → POST /api/share → parse 201 → GET the served .mpx →
    /// re-parse with the importer → identical playlist.
    /// Run `node handoff/share-server/standalone.js` first, then
    /// `cargo test share_e2e -- --include-ignored`.
    #[tokio::test]
    #[ignore = "requires the standalone share server on localhost:3001"]
    async fn share_e2e_round_trip_via_server() {
        use crate::library::model::{Capability, Track};
        use crate::sources::{mpx, mpx_export};

        let track = Track {
            id: 1,
            title: Some("Mr. Blue Sky".into()),
            artist: Some("ELO".into()),
            album: Some("Out of the Blue".into()),
            year: Some(1977),
            genre: Some("Rock".into()),
            bpm: None,
            musical_key: None,
            duration_ms: Some(303_500),
            uri: "https://www.youtube.com/watch?v=aQUlA8Hcv4s".into(),
            source_kind: "youtube".into(),
            capability: Capability::StreamPlayable,
            media_type: "music".into(),
            fingerprint: None,
            musicbrainz_id: None,
            art_path: Some("https://i.ytimg.com/vi/aQUlA8Hcv4s/hqdefault.jpg".into()),
            rating: 0,
            play_count: 0,
            added_at: 0,
        };
        let (mpx_json, stats) = mpx_export::export_mpx("E2E Trip", None, &[track]);
        assert_eq!(stats.included, 1);

        let payload = serde_json::json!({
            "recipientEmail": "e2e@test.example",
            "senderName": "Cargo Test",
            "playlistName": "E2E Trip",
            "mpx": mpx_json,
        });
        let resp = http()
            .post("http://localhost:3001/api/share")
            .json(&payload)
            .send()
            .await
            .expect("standalone share server must be running on :3001");
        assert_eq!(resp.status().as_u16(), 201, "share should be created");
        let created: serde_json::Value = resp.json().await.expect("201 body parses");
        let id = created["id"].as_str().expect("id present");
        assert!(created["shareUrl"].as_str().unwrap().contains(id));

        // Landing page renders (and escapes) — plain smoke check.
        let page = http()
            .get(format!("http://localhost:3001/share/{id}"))
            .send()
            .await
            .expect("landing reachable");
        assert_eq!(page.status().as_u16(), 200);
        let html = page.text().await.expect("landing body");
        assert!(html.contains("Cargo Test shared a playlist"));
        assert!(html.contains("Mr. Blue Sky"));

        // The served .mpx re-imports to the identical playlist.
        let file = http()
            .get(format!("http://localhost:3001/api/share/{id}.mpx"))
            .send()
            .await
            .expect(".mpx reachable")
            .bytes()
            .await
            .expect(".mpx body");
        let parsed = mpx::parse_mpx(&file).expect("served .mpx parses with the importer");
        assert_eq!(parsed.name, "E2E Trip");
        assert_eq!(parsed.tracks.len(), 1);
        let t = &parsed.tracks[0];
        assert_eq!(t.title.as_deref(), Some("Mr. Blue Sky"));
        assert_eq!(t.duration_ms, Some(303_500), "ms exact through the whole loop");
        assert_eq!(t.source_type.as_deref(), Some("youtube"));
        assert_eq!(
            t.url.as_deref(),
            Some("https://www.youtube.com/watch?v=aQUlA8Hcv4s")
        );
    }
}
