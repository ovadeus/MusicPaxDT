//! Enrichment commands: per-track and batch metadata fill, plus the
//! Integrations credentials/settings that drive it. Honors CLAUDE.md: free
//! tiers first, paid LLM only when permitted and under a spend cap, keys in
//! the OS keychain.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::LlmProvider;
use crate::enrich::{self, fingerprint, EnrichConfig};
use crate::error::{AppError, AppResult};
use crate::library::db;
use crate::library::model::{MetadataSuggestion, Track};
use crate::net::{keyring_get, keyring_set};
use crate::state::{lock_unpoisoned, AppState};

// MusicBrainz asks anonymous callers to stay at ~1 req/s.
const MB_COURTESY_DELAY: Duration = Duration::from_millis(1100);

// --- Integrations status & credentials -------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichIntegrationStatus {
    pub acoustid_key: bool,
    pub anthropic_key: bool,
    pub openai_key: bool,
    pub fpcalc_found: bool,
    pub fpcalc_path: Option<String>,
}

fn fpcalc_setting(conn: &rusqlite::Connection) -> AppResult<Option<String>> {
    db::get_setting(conn, "enrich.fpcalc_path")
}

#[tauri::command]
pub async fn enrich_integration_status(
    state: State<'_, AppState>,
) -> AppResult<EnrichIntegrationStatus> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let configured = {
            let conn = lock_unpoisoned(&db);
            fpcalc_setting(&conn)?
        };
        let resolved = fingerprint::resolve_fpcalc(configured.as_deref());
        Ok(EnrichIntegrationStatus {
            acoustid_key: keyring_get("acoustid_key").is_some(),
            anthropic_key: keyring_get("anthropic_api_key").is_some(),
            openai_key: keyring_get("openai_api_key").is_some(),
            fpcalc_found: resolved.is_some(),
            fpcalc_path: resolved.map(|p| p.to_string_lossy().into_owned()),
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("status task failed: {e}")))?
}

#[tauri::command]
pub fn set_acoustid_key(key: String) -> AppResult<()> {
    keyring_set("acoustid_key", key.trim()).map_err(AppError::Other)
}

#[tauri::command]
pub fn set_anthropic_key(key: String) -> AppResult<()> {
    keyring_set("anthropic_api_key", key.trim()).map_err(AppError::Other)
}

#[tauri::command]
pub fn set_openai_key(key: String) -> AppResult<()> {
    keyring_set("openai_api_key", key.trim()).map_err(AppError::Other)
}

// --- config assembly --------------------------------------------------------

/// Resolve the LLM provider from settings (`enrich.ai_provider`, `enrich.ai_model`)
/// + keychain. Returns None when the chosen provider has no credential.
fn resolve_llm(conn: &rusqlite::Connection) -> AppResult<Option<LlmProvider>> {
    let provider = db::get_setting(conn, "enrich.ai_provider")?.unwrap_or_else(|| "none".into());
    let model = db::get_setting(conn, "enrich.ai_model")?;
    Ok(match provider.as_str() {
        "anthropic" => keyring_get("anthropic_api_key").map(|api_key| LlmProvider::Anthropic {
            api_key,
            model: model.unwrap_or_else(|| "claude-opus-4-8".into()),
        }),
        "openai" => keyring_get("openai_api_key").map(|api_key| LlmProvider::OpenAi {
            api_key,
            model: model.unwrap_or_else(|| "gpt-4o-mini".into()),
        }),
        "ollama" => {
            let host = db::get_setting(conn, "enrich.ollama_host")?
                .unwrap_or_else(|| "http://localhost:11434".into());
            Some(LlmProvider::Ollama {
                host,
                model: model.unwrap_or_else(|| "llama3".into()),
            })
        }
        _ => None,
    })
}

fn build_config(conn: &rusqlite::Connection) -> AppResult<EnrichConfig> {
    let fpcalc_path = fingerprint::resolve_fpcalc(fpcalc_setting(conn)?.as_deref());
    Ok(EnrichConfig {
        acoustid_key: keyring_get("acoustid_key"),
        fpcalc_path,
        llm: resolve_llm(conn)?,
    })
}

fn spend_cap_usd(conn: &rusqlite::Connection) -> f64 {
    db::get_setting(conn, "enrich.spend_cap_usd")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(1.0) // default $1 cap per batch
}

// --- applying a suggestion --------------------------------------------------

/// Cache cover art for a track into the app's `art/` dir; returns the path.
async fn cache_art(app: &AppHandle, track_id: i64, url: &str) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?.join("art");
    std::fs::create_dir_all(&dir).ok()?;
    let dest = dir.join(format!("{track_id}.jpg"));
    match enrich::download_art(url, &dest).await {
        Ok(()) => Some(dest.to_string_lossy().into_owned()),
        Err(e) => {
            eprintln!("cover art for track {track_id} failed: {e}");
            None
        }
    }
}

/// Merge a suggestion onto a track in the DB (non-null fields win), write tags
/// back for OWNED local files, and cache art. Returns the updated track.
async fn apply_suggestion(
    app: &AppHandle,
    state_db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    track: &Track,
    s: &MetadataSuggestion,
) -> AppResult<Track> {
    let art_path = match &s.art_url {
        Some(url) => cache_art(app, track.id, url).await,
        None => None,
    };

    let db = state_db.clone();
    let track_id = track.id;
    let edit = db::TrackEdit {
        title: s.title.clone().or_else(|| track.title.clone()),
        artist: s.artist.clone().or_else(|| track.artist.clone()),
        album: s.album.clone().or_else(|| track.album.clone()),
        year: s.year.or(track.year),
        genre: s.genre.clone().or_else(|| track.genre.clone()),
    };
    let mbid = s.musicbrainz_id.clone();
    let owned_local = track.capability == crate::library::model::Capability::Owned
        && track.source_kind == "local";

    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        let updated = db::update_track_metadata(&conn, track_id, &edit)?;
        if let Some(mbid) = mbid {
            db::set_track_musicbrainz_id(&conn, track_id, &mbid)?;
        }
        if let Some(art) = art_path {
            db::set_track_art_path(&conn, track_id, &art)?;
        }
        if owned_local {
            crate::library::scan::write_tags(&updated);
        }
        db::get_track(&conn, track_id)
    })
    .await
    .map_err(|e| AppError::Other(format!("apply task failed: {e}")))?
}

// --- commands ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichResult {
    pub track: Track,
    pub suggestion: Option<MetadataSuggestion>,
    pub applied: bool,
}

/// Enrich a single track and apply the result. Used by the per-row button.
#[tauri::command]
pub async fn enrich_track(
    track_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<EnrichResult> {
    let db = state.db.clone();
    let (track, cfg) = {
        let conn = lock_unpoisoned(&db);
        (db::get_track(&conn, track_id)?, build_config(&conn)?)
    };

    let outcome = enrich::enrich_track(&track, &cfg, true)
        .await
        .map_err(AppError::Other)?;

    if let Some(s) = &outcome.suggestion {
        let updated = apply_suggestion(&app, &db, &track, s).await?;
        Ok(EnrichResult {
            track: updated,
            suggestion: Some(s.clone()),
            applied: true,
        })
    } else {
        Ok(EnrichResult {
            track,
            suggestion: None,
            applied: false,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrichProgress {
    done: usize,
    total: usize,
    matched: usize,
    spent_usd: f64,
    current: String,
    capped: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichBatchReport {
    pub total: usize,
    pub matched: usize,
    pub spent_usd: f64,
    pub capped: bool,
}

/// Enrich every track whose ids are given (the current library view). Emits
/// `enrich-progress`; stops paid LLM calls once the spend cap is reached
/// (free tiers keep running).
#[tauri::command]
pub async fn enrich_tracks(
    track_ids: Vec<i64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<EnrichBatchReport> {
    let db = state.db.clone();
    let (cfg, cap) = {
        let conn = lock_unpoisoned(&db);
        (build_config(&conn)?, spend_cap_usd(&conn))
    };
    let per_call = cfg.llm.as_ref().map(|l| l.estimate_cost_usd()).unwrap_or(0.0);

    let total = track_ids.len();
    let mut matched = 0usize;
    let mut spent = 0.0f64;
    let mut capped = false;

    for (i, id) in track_ids.into_iter().enumerate() {
        let track = {
            let conn = lock_unpoisoned(&db);
            match db::get_track(&conn, id) {
                Ok(t) => t,
                Err(_) => continue,
            }
        };
        let label = track.title.clone().unwrap_or_else(|| format!("track {id}"));

        // Permit the paid tier only if the next call stays within the cap.
        let allow_llm = !capped && (spent + per_call) <= cap;

        let _ = app.emit(
            "enrich-progress",
            EnrichProgress {
                done: i,
                total,
                matched,
                spent_usd: spent,
                current: label.clone(),
                capped,
            },
        );

        match enrich::enrich_track(&track, &cfg, allow_llm).await {
            Ok(outcome) => {
                if outcome.used_llm {
                    spent += per_call;
                    if spent + per_call > cap {
                        capped = true;
                    }
                }
                if let Some(s) = &outcome.suggestion {
                    if apply_suggestion(&app, &db, &track, s).await.is_ok() {
                        matched += 1;
                    }
                }
            }
            Err(e) => eprintln!("enrich {id} failed: {e}"),
        }

        tokio::time::sleep(MB_COURTESY_DELAY).await;
    }

    let _ = app.emit(
        "enrich-progress",
        EnrichProgress {
            done: total,
            total,
            matched,
            spent_usd: spent,
            current: String::new(),
            capped,
        },
    );

    Ok(EnrichBatchReport {
        total,
        matched,
        spent_usd: spent,
        capped,
    })
}

/// Cost estimate for enriching `count` tracks with the configured provider,
/// shown before a batch so the user can decide.
#[tauri::command]
pub async fn enrich_cost_estimate(
    count: usize,
    state: State<'_, AppState>,
) -> AppResult<f64> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_unpoisoned(&db);
        let per = resolve_llm(&conn)?
            .map(|l| l.estimate_cost_usd())
            .unwrap_or(0.0);
        Ok(per * count as f64)
    })
    .await
    .map_err(|e| AppError::Other(format!("estimate task failed: {e}")))?
}
