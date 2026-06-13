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

// --- commands: propose (no writes) then apply only what the user approves ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrichProgress {
    done: usize,
    total: usize,
    proposed: usize,
    spent_usd: f64,
    current: String,
    capped: bool,
}

/// One track's proposal: the current track plus the suggested fields. Nothing
/// is written — the UI shows current→proposed and the user approves per field.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichProposal {
    pub track: Track,
    pub suggestion: MetadataSuggestion,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichProposeReport {
    pub proposals: Vec<EnrichProposal>,
    pub total: usize,
    pub spent_usd: f64,
    pub capped: bool,
}

/// Run the enrichment chain over the given tracks and RETURN proposals without
/// touching the library. Emits `enrich-progress`; meters and caps paid LLM spend.
#[tauri::command]
pub async fn propose_enrichment(
    track_ids: Vec<i64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<EnrichProposeReport> {
    let db = state.db.clone();
    let (cfg, cap) = {
        let conn = lock_unpoisoned(&db);
        (build_config(&conn)?, spend_cap_usd(&conn))
    };
    let per_call = cfg.llm.as_ref().map(|l| l.estimate_cost_usd()).unwrap_or(0.0);

    let total = track_ids.len();
    let mut proposals = Vec::new();
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
        let allow_llm = !capped && (spent + per_call) <= cap;

        let _ = app.emit(
            "enrich-progress",
            EnrichProgress {
                done: i,
                total,
                proposed: proposals.len(),
                spent_usd: spent,
                current: label,
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
                if let Some(suggestion) = outcome.suggestion {
                    // Only surface a proposal if it actually changes something.
                    let changes = suggestion.title.is_some()
                        || suggestion.artist.is_some()
                        || suggestion.album.is_some()
                        || suggestion.year.is_some()
                        || suggestion.genre.is_some()
                        || suggestion.art_url.is_some();
                    if changes {
                        proposals.push(EnrichProposal { track, suggestion });
                    }
                }
            }
            Err(e) => eprintln!("propose {id} failed: {e}"),
        }

        tokio::time::sleep(MB_COURTESY_DELAY).await;
    }

    let _ = app.emit(
        "enrich-progress",
        EnrichProgress {
            done: total,
            total,
            proposed: proposals.len(),
            spent_usd: spent,
            current: String::new(),
            capped,
        },
    );

    Ok(EnrichProposeReport {
        proposals,
        total,
        spent_usd: spent,
        capped,
    })
}

/// One approved edit from the review dialog. Each field carries the final
/// value to set, or null to leave the track's current value untouched.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedEdit {
    pub track_id: i64,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub art_url: Option<String>,
    pub musicbrainz_id: Option<String>,
}

/// Apply the user-approved edits. Only the fields present (non-null) are
/// changed; everything else keeps the track's current value. Writes tags back
/// for OWNED local files and caches approved cover art.
#[tauri::command]
pub async fn apply_enrichment(
    edits: Vec<ApprovedEdit>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    let db = state.db.clone();
    let mut applied = 0usize;

    for e in edits {
        let track = {
            let conn = lock_unpoisoned(&db);
            match db::get_track(&conn, e.track_id) {
                Ok(t) => t,
                Err(_) => continue,
            }
        };
        let art_path = match &e.art_url {
            Some(url) => cache_art(&app, e.track_id, url).await,
            None => None,
        };
        let db2 = db.clone();
        let owned_local = track.capability == crate::library::model::Capability::Owned
            && track.source_kind == "local";
        let edit = db::TrackEdit {
            title: e.title.or(track.title.clone()),
            artist: e.artist.or(track.artist.clone()),
            album: e.album.or(track.album.clone()),
            year: e.year.or(track.year),
            genre: e.genre.or(track.genre.clone()),
        };
        let mbid = e.musicbrainz_id.clone();
        let track_id = e.track_id;
        let ok = tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
            let conn = lock_unpoisoned(&db2);
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
            Ok(())
        })
        .await
        .map_err(|e| AppError::Other(format!("apply task failed: {e}")))?;
        if ok.is_ok() {
            applied += 1;
        }
    }
    Ok(applied)
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
