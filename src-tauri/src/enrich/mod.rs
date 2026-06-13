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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::model::Capability;

    fn track(title: &str, artist: &str) -> Track {
        Track {
            id: 1,
            title: Some(title.into()),
            artist: Some(artist.into()),
            album: None,
            year: None,
            genre: None,
            bpm: None,
            musical_key: None,
            duration_ms: None,
            uri: "/music/x.flac".into(),
            source_kind: "local".into(),
            capability: Capability::Owned,
            fingerprint: None,
            musicbrainz_id: None,
            art_path: None,
            rating: 0,
            play_count: 0,
            added_at: 0,
        }
    }

    /// Live free-tier run of the orchestrator (the exact path the Enrich
    /// button calls) — no AcoustID, no LLM. Confirms MusicBrainz fills the
    /// album/year for a well-known recording.
    #[tokio::test]
    #[ignore = "requires network access"]
    async fn orchestrator_free_tier_fills_album_and_year() {
        let cfg = EnrichConfig {
            acoustid_key: None,
            fpcalc_path: None,
            llm: None,
        };
        let t = track("Smells Like Teen Spirit", "Nirvana");
        let outcome = enrich_track(&t, &cfg, true).await.expect("enrich ok");
        let s = outcome.suggestion.expect("a suggestion");
        assert!(!outcome.used_llm, "free tier must not touch the LLM");
        assert_eq!(s.source, "musicbrainz");
        assert!(s.album.is_some(), "album should be filled, got {:?}", s.album);
        assert_eq!(s.year, Some(1991), "Nevermind released 1991");
        assert!(s.musicbrainz_id.is_some(), "should carry an MBID");
        assert!(s.confidence >= 0.9, "exact match should be confident");
    }
}
