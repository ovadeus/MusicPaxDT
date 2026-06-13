//! Tier 2 enrichment: Chromaprint acoustic fingerprint (via the `fpcalc`
//! binary) → AcoustID lookup → MusicBrainz recording id. Identifies the actual
//! recording regardless of how a local file is named or tagged.
//!
//! `fpcalc` is an external binary (part of Chromaprint). For distribution it
//! should be bundled as a Tauri sidecar; here we resolve it from a
//! user-configured path, then PATH, then a few well-known install locations
//! (including MusicBrainz Picard, which ships it).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

use crate::library::model::MetadataSuggestion;
use crate::net::http;
use crate::sources::musicbrainz;

/// Candidate locations for `fpcalc` beyond an explicit setting and PATH.
const KNOWN_FPCALC_PATHS: &[&str] = &[
    "/Applications/MusicBrainz Picard.app/Contents/MacOS/fpcalc",
    "/opt/homebrew/bin/fpcalc",
    "/usr/local/bin/fpcalc",
    "/usr/bin/fpcalc",
    "C:\\Program Files\\MusicBrainz Picard\\fpcalc.exe",
];

/// Resolve the fpcalc binary. `configured` is the user's Settings override.
pub fn resolve_fpcalc(configured: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    // On PATH?
    let probe = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = Command::new(probe).arg("fpcalc").output() {
        if out.status.success() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let path = PathBuf::from(line.trim());
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    KNOWN_FPCALC_PATHS
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

#[derive(Debug)]
pub struct Fingerprint {
    pub fingerprint: String,
    pub duration_secs: f64,
}

#[derive(Deserialize)]
struct FpcalcJson {
    duration: f64,
    fingerprint: String,
}

/// Compute a Chromaprint fingerprint for a local audio file.
pub fn compute(fpcalc: &Path, audio: &Path) -> Result<Fingerprint, String> {
    let out = Command::new(fpcalc)
        .arg("-json")
        .arg(audio)
        .output()
        .map_err(|e| format!("could not run fpcalc: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "fpcalc failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let parsed: FpcalcJson = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("fpcalc output parse failed: {e}"))?;
    Ok(Fingerprint {
        fingerprint: parsed.fingerprint,
        duration_secs: parsed.duration,
    })
}

#[derive(Deserialize)]
struct AcoustIdResponse {
    status: String,
    results: Option<Vec<AcoustIdResult>>,
    error: Option<AcoustIdError>,
}
#[derive(Deserialize)]
struct AcoustIdError {
    message: String,
}
#[derive(Deserialize)]
struct AcoustIdResult {
    score: Option<f32>,
    recordings: Option<Vec<AcoustIdRecording>>,
}
#[derive(Deserialize)]
struct AcoustIdRecording {
    id: Option<String>,
}

/// Submit a fingerprint to AcoustID (user's free API key) and return the best
/// MusicBrainz recording id with its match score.
pub async fn acoustid_lookup(
    api_key: &str,
    fp: &Fingerprint,
) -> Result<Option<(String, f32)>, String> {
    let duration = (fp.duration_secs.round() as i64).to_string();
    let resp = http()
        .get("https://api.acoustid.org/v2/lookup")
        .query(&[
            ("client", api_key),
            ("meta", "recordingids"),
            ("duration", duration.as_str()),
            ("fingerprint", fp.fingerprint.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("AcoustID request failed: {e}"))?;
    let body: AcoustIdResponse = resp
        .json()
        .await
        .map_err(|e| format!("AcoustID parse failed: {e}"))?;
    if body.status != "ok" {
        return Err(format!(
            "AcoustID error: {}",
            body.error.map(|e| e.message).unwrap_or_else(|| "unknown".into())
        ));
    }
    let best = body
        .results
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.recordings.as_ref().is_some_and(|rs| !rs.is_empty()))
        .max_by(|a, b| {
            a.score
                .unwrap_or(0.0)
                .total_cmp(&b.score.unwrap_or(0.0))
        });
    let Some(best) = best else { return Ok(None) };
    let score = best.score.unwrap_or(0.0);
    let mbid = best
        .recordings
        .and_then(|rs| rs.into_iter().find_map(|r| r.id));
    Ok(mbid.map(|id| (id, score)))
}

/// Full Tier 2 chain for one local file: fingerprint → AcoustID → MusicBrainz.
pub async fn identify(
    fpcalc: &Path,
    audio: &Path,
    acoustid_key: &str,
) -> Result<Option<MetadataSuggestion>, String> {
    let fp = compute(fpcalc, audio)?;
    let Some((mbid, score)) = acoustid_lookup(acoustid_key, &fp).await? else {
        return Ok(None);
    };
    if score < 0.5 {
        return Ok(None);
    }
    let mut suggestion = musicbrainz::lookup_by_recording_id(&mbid).await?;
    if let Some(s) = suggestion.as_mut() {
        // Blend AcoustID's match score into the confidence.
        s.confidence = (0.85 + score * 0.15).min(1.0);
    }
    Ok(suggestion)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_configured_path_when_valid() {
        // A path that exists (this source file) stands in for the binary.
        let me = file!();
        assert_eq!(
            resolve_fpcalc(Some(me)).as_deref(),
            Some(Path::new(me)),
            "a valid configured path should win"
        );
        assert!(
            resolve_fpcalc(Some("/no/such/fpcalc/here"))
                .is_none_or(|p| p != Path::new("/no/such/fpcalc/here")),
            "an invalid configured path must not be returned verbatim"
        );
    }

    /// Live fingerprint compute against a generated WAV. Needs fpcalc present.
    #[test]
    #[ignore = "requires the fpcalc binary"]
    fn computes_a_fingerprint() {
        let Some(fpcalc) = resolve_fpcalc(None) else {
            eprintln!("SKIP: fpcalc not installed");
            return;
        };
        let dir = std::env::temp_dir().join(format!("stack-fp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("tone.wav");
        // 8s sine so fpcalc has enough audio.
        let rate = 44_100u32;
        let n = rate * 8;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + n * 2).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(n * 2).to_le_bytes());
        for i in 0..n {
            let t = i as f32 / rate as f32;
            let v = ((2.0 * std::f32::consts::PI * 440.0 * t).sin() * 16000.0) as i16;
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        std::fs::write(&wav, bytes).unwrap();

        let fp = compute(&fpcalc, &wav).expect("fingerprint computed");
        assert!(!fp.fingerprint.is_empty());
        assert!((fp.duration_secs - 8.0).abs() < 0.5);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
