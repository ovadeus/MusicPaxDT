//! Tier 1 enrichment: MusicBrainz (free, no key) for authoritative
//! artist/album/year + Cover Art Archive for front cover. This is the source
//! of truth CLAUDE.md mandates trying before any paid LLM call.

use serde::Deserialize;

use crate::library::model::MetadataSuggestion;
use crate::net::http;

#[derive(Debug, Deserialize)]
struct RecordingSearch {
    recordings: Option<Vec<Recording>>,
}

#[derive(Debug, Deserialize)]
struct Recording {
    title: Option<String>,
    score: Option<i64>,
    #[serde(rename = "artist-credit")]
    artist_credit: Option<Vec<ArtistCredit>>,
    releases: Option<Vec<Release>>,
}

#[derive(Debug, Deserialize)]
struct ArtistCredit {
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Release {
    #[allow(dead_code)] // read by tests to assert release selection
    id: Option<String>,
    date: Option<String>,
    #[serde(rename = "release-group")]
    release_group: Option<ReleaseGroup>,
}

#[derive(Debug, Deserialize)]
struct ReleaseGroup {
    id: Option<String>,
    #[serde(rename = "primary-type")]
    primary_type: Option<String>,
    title: Option<String>,
}

/// Lucene-escape a user string for the MusicBrainz query DSL.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(
            c,
            '+' | '-' | '&' | '|' | '!' | '(' | ')' | '{' | '}' | '[' | ']' | '^'
                | '"' | '~' | '*' | '?' | ':' | '\\' | '/'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Pick the best release for a recording: prefer an official-looking studio
/// **Album** with the earliest date (the original release, not a later live
/// or compilation reissue that MusicBrainz often returns first).
fn best_release(releases: &[Release]) -> Option<&Release> {
    let album_rank = |r: &Release| -> u8 {
        match r
            .release_group
            .as_ref()
            .and_then(|g| g.primary_type.as_deref())
        {
            Some("Album") => 0,
            Some("EP") => 1,
            Some("Single") => 2,
            _ => 3,
        }
    };
    let year_of = |r: &Release| -> i64 {
        r.date
            .as_deref()
            .and_then(|d| d.get(0..4))
            .and_then(|y| y.parse::<i64>().ok())
            .unwrap_or(i64::MAX)
    };
    releases
        .iter()
        .min_by(|a, b| {
            album_rank(a)
                .cmp(&album_rank(b))
                .then(year_of(a).cmp(&year_of(b)))
        })
}

fn cover_art_url(release_group_id: &str) -> String {
    // Release-group front cover is the most representative; -500 is a sane size.
    format!("https://coverartarchive.org/release-group/{release_group_id}/front-500")
}

/// Look up a recording by artist + title. Returns a suggestion when a
/// confident match is found. `artist` may be empty (title-only search).
pub async fn lookup(artist: &str, title: &str) -> Result<Option<MetadataSuggestion>, String> {
    let title = title.trim();
    if title.is_empty() {
        return Ok(None);
    }
    let query = if artist.trim().is_empty() {
        format!("recording:\"{}\"", escape(title))
    } else {
        format!(
            "artist:\"{}\" AND recording:\"{}\"",
            escape(artist.trim()),
            escape(title)
        )
    };

    let resp = http()
        .get("https://musicbrainz.org/ws/2/recording")
        .query(&[
            ("query", query.as_str()),
            ("fmt", "json"),
            ("limit", "5"),
        ])
        .send()
        .await
        .map_err(|e| format!("MusicBrainz request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("MusicBrainz returned HTTP {}", resp.status()));
    }
    let body: RecordingSearch = resp
        .json()
        .await
        .map_err(|e| format!("MusicBrainz parse failed: {e}"))?;

    let recordings = body.recordings.unwrap_or_default();
    let Some(best) = recordings.into_iter().max_by_key(|r| r.score.unwrap_or(0)) else {
        return Ok(None);
    };
    let score = best.score.unwrap_or(0);
    if score < 80 {
        return Ok(None); // too weak to trust without the fingerprint/LLM tiers
    }

    let mut suggestion = MetadataSuggestion {
        title: best.title.clone(),
        artist: best
            .artist_credit
            .as_ref()
            .and_then(|cs| cs.first())
            .and_then(|c| c.name.clone()),
        source: "musicbrainz".into(),
        confidence: (score as f32 / 100.0).min(1.0),
        ..Default::default()
    };

    if let Some(release) = best.releases.as_deref().and_then(best_release) {
        suggestion.year = release
            .date
            .as_deref()
            .and_then(|d| d.get(0..4))
            .and_then(|y| y.parse::<i64>().ok());
        if let Some(group) = &release.release_group {
            suggestion.album = group.title.clone();
            if let Some(gid) = &group.id {
                suggestion.art_url = Some(cover_art_url(gid));
            }
        }
    }

    Ok(Some(suggestion))
}

/// Authoritative lookup by MusicBrainz recording id (used after AcoustID
/// resolves a fingerprint to a recording). Includes release-groups + genres.
pub async fn lookup_by_recording_id(mbid: &str) -> Result<Option<MetadataSuggestion>, String> {
    #[derive(Deserialize)]
    struct RecordingLookup {
        title: Option<String>,
        #[serde(rename = "artist-credit")]
        artist_credit: Option<Vec<ArtistCredit>>,
        releases: Option<Vec<Release>>,
        genres: Option<Vec<Genre>>,
    }
    #[derive(Deserialize)]
    struct Genre {
        name: Option<String>,
        count: Option<i64>,
    }

    let resp = http()
        .get(format!("https://musicbrainz.org/ws/2/recording/{mbid}"))
        .query(&[
            ("fmt", "json"),
            ("inc", "artist-credits+releases+release-groups+genres"),
        ])
        .send()
        .await
        .map_err(|e| format!("MusicBrainz lookup failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("MusicBrainz returned HTTP {}", resp.status()));
    }
    let r: RecordingLookup = resp
        .json()
        .await
        .map_err(|e| format!("MusicBrainz parse failed: {e}"))?;

    let mut suggestion = MetadataSuggestion {
        title: r.title.clone(),
        artist: r
            .artist_credit
            .as_ref()
            .and_then(|cs| cs.first())
            .and_then(|c| c.name.clone()),
        musicbrainz_id: Some(mbid.to_string()),
        source: "acoustid".into(),
        confidence: 0.97, // fingerprint match is near-certain
        ..Default::default()
    };
    if let Some(release) = r.releases.as_deref().and_then(best_release) {
        suggestion.year = release
            .date
            .as_deref()
            .and_then(|d| d.get(0..4))
            .and_then(|y| y.parse::<i64>().ok());
        if let Some(group) = &release.release_group {
            suggestion.album = group.title.clone();
            if let Some(gid) = &group.id {
                suggestion.art_url = Some(cover_art_url(gid));
            }
        }
    }
    // Most-voted genre, if MusicBrainz has any.
    if let Some(genres) = r.genres {
        if let Some(g) = genres
            .into_iter()
            .filter(|g| g.name.is_some())
            .max_by_key(|g| g.count.unwrap_or(0))
        {
            suggestion.genre = g.name;
        }
    }
    Ok(Some(suggestion))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_lucene_metacharacters() {
        assert_eq!(escape("AC/DC"), "AC\\/DC");
        assert_eq!(escape("Sun (feat. X)"), "Sun \\(feat. X\\)");
        assert_eq!(escape("plain"), "plain");
    }

    #[test]
    fn best_release_prefers_earliest_studio_album() {
        let releases = vec![
            Release {
                id: Some("live".into()),
                date: Some("1994-01-01".into()),
                release_group: Some(ReleaseGroup {
                    id: Some("g-live".into()),
                    primary_type: Some("Live".into()),
                    title: Some("Live 1994".into()),
                }),
            },
            Release {
                id: Some("reissue".into()),
                date: Some("2009-01-01".into()),
                release_group: Some(ReleaseGroup {
                    id: Some("g-album".into()),
                    primary_type: Some("Album".into()),
                    title: Some("Diamond Life".into()),
                }),
            },
            Release {
                id: Some("orig".into()),
                date: Some("1984-07-16".into()),
                release_group: Some(ReleaseGroup {
                    id: Some("g-album".into()),
                    primary_type: Some("Album".into()),
                    title: Some("Diamond Life".into()),
                }),
            },
        ];
        let best = best_release(&releases).unwrap();
        assert_eq!(best.id.as_deref(), Some("orig")); // album beats live, 1984 beats 2009
    }

    /// Live MusicBrainz lookup. Network-gated.
    #[tokio::test]
    #[ignore = "requires network access"]
    async fn live_lookup_resolves_a_known_track() {
        let s = lookup("Sade", "Smooth Operator")
            .await
            .expect("request ok")
            .expect("a match");
        assert_eq!(s.artist.as_deref(), Some("Sade"));
        assert!(s.year.is_some());
        assert!(s.art_url.is_some());
        assert!(s.confidence >= 0.8);
    }
}
