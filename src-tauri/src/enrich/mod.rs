//! Metadata enrichment orchestrator. Runs the tiers in the order CLAUDE.md
//! mandates — free MusicBrainz, then free Chromaprint/AcoustID fingerprint,
//! then (only if needed and permitted) the paid LLM, whose cleaned output is
//! always re-confirmed against free MusicBrainz before being trusted.

pub mod fingerprint;

use std::path::{Path, PathBuf};

use crate::ai::LlmProvider;
use crate::library::model::{MetadataSuggestion, Track};
use crate::sources::musicbrainz;

pub struct EnrichConfig {
    pub acoustid_key: Option<String>,
    pub fpcalc_path: Option<PathBuf>,
    pub llm: Option<LlmProvider>,
}

/// Did this enrichment consult the paid LLM? (so the batch driver can meter spend)
#[derive(Debug, Default)]
pub struct EnrichOutcome {
    pub suggestion: Option<MetadataSuggestion>,
    pub used_llm: bool,
}

fn nonempty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// Enrich one track. `allow_llm` lets the batch driver keep running the free
/// tiers after a spend cap is hit while skipping further paid calls.
pub async fn enrich_track(
    track: &Track,
    cfg: &EnrichConfig,
    allow_llm: bool,
) -> Result<EnrichOutcome, String> {
    // Tier 1 (free): MusicBrainz text search using whatever tags we have.
    if let Some(title) = nonempty(&track.title) {
        let artist = nonempty(&track.artist).unwrap_or("");
        if let Some(s) = musicbrainz::lookup(artist, title).await? {
            if s.confidence >= 0.9 {
                return Ok(EnrichOutcome {
                    suggestion: Some(s),
                    used_llm: false,
                });
            }
        }
    }

    // Tier 2 (free): fingerprint local OWNED audio → AcoustID → MusicBrainz.
    if track.capability == crate::library::model::Capability::Owned
        && track.source_kind == "local"
    {
        if let (Some(key), Some(fpcalc)) = (
            nonempty(&cfg.acoustid_key),
            cfg.fpcalc_path.as_deref().filter(|p| p.is_file()),
        ) {
            let audio = PathBuf::from(&track.uri);
            if audio.is_file() {
                match fingerprint::identify(fpcalc, &audio, key).await {
                    Ok(Some(s)) => {
                        return Ok(EnrichOutcome {
                            suggestion: Some(s),
                            used_llm: false,
                        })
                    }
                    Ok(None) => {}
                    Err(e) => eprintln!("fingerprint identify failed for {}: {e}", track.uri),
                }
            }
        }
    }

    // Tier 3 (paid): LLM cleans the messy label, then MusicBrainz confirms.
    if allow_llm {
        if let Some(llm) = &cfg.llm {
            let raw_title = nonempty(&track.title).unwrap_or("");
            if !raw_title.is_empty() {
                match llm.clean_metadata(raw_title, nonempty(&track.artist)).await {
                    Ok(cleaned) => {
                        let c_title = nonempty(&cleaned.title);
                        let c_artist = nonempty(&cleaned.artist);
                        // Re-confirm against free MusicBrainz — the source of truth.
                        if let Some(title) = c_title {
                            if let Some(mut s) =
                                musicbrainz::lookup(c_artist.unwrap_or(""), title).await?
                            {
                                if s.confidence >= 0.85 {
                                    s.source = "llm+musicbrainz".into();
                                    return Ok(EnrichOutcome {
                                        suggestion: Some(s),
                                        used_llm: true,
                                    });
                                }
                            }
                        }
                        // MusicBrainz couldn't confirm — fall back to the LLM's
                        // own cleanup at lower confidence (better than the junk title).
                        if c_title.is_some() || c_artist.is_some() {
                            return Ok(EnrichOutcome {
                                suggestion: Some(MetadataSuggestion {
                                    title: cleaned.title,
                                    artist: cleaned.artist,
                                    album: cleaned.album,
                                    genre: cleaned.genre,
                                    source: "llm".into(),
                                    confidence: 0.5,
                                    ..Default::default()
                                }),
                                used_llm: true,
                            });
                        }
                    }
                    Err(e) => eprintln!("LLM cleanup failed for {}: {e}", track.uri),
                }
                return Ok(EnrichOutcome {
                    suggestion: None,
                    used_llm: true,
                });
            }
        }
    }

    Ok(EnrichOutcome::default())
}

/// Download cover art to `dest` (PNG/JPEG bytes as served). Best-effort.
pub async fn download_art(url: &str, dest: &Path) -> Result<(), String> {
    let resp = crate::net::http()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("cover art request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("cover art HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("cover art read failed: {e}"))?;
    std::fs::write(dest, &bytes).map_err(|e| format!("cover art write failed: {e}"))?;
    Ok(())
}
