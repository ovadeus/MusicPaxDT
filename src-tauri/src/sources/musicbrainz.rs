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
    id: Option<String>,
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
    status: Option<String>,
    #[serde(rename = "release-group")]
    release_group: Option<ReleaseGroup>,
}

#[derive(Debug, Deserialize)]
struct ReleaseGroup {
    id: Option<String>,
    #[serde(rename = "primary-type")]
    primary_type: Option<String>,
    #[serde(rename = "secondary-types")]
    secondary_types: Option<Vec<String>>,
    /// The album's original release date, stable across pressings/reissues.
    #[serde(rename = "first-release-date")]
    first_release_date: Option<String>,
    title: Option<String>,
}

/// Parse a leading "YYYY" out of a MusicBrainz date string.
fn parse_year(date: Option<&str>) -> Option<i64> {
    date.and_then(|d| d.get(0..4)).and_then(|y| y.parse().ok())
}

/// The album year for a release — its group's original date if known, else
/// this pressing's date.
fn release_year(r: &Release) -> Option<i64> {
    r.release_group
        .as_ref()
        .and_then(|g| parse_year(g.first_release_date.as_deref()))
        .or_else(|| parse_year(r.date.as_deref()))
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

fn year_of(r: &Release) -> i64 {
    release_year(r).unwrap_or(i64::MAX)
}

/// Lower is better. A release's desirability for "what album is this song
/// from": prefer an Official, primary studio **Album** that is NOT a
/// compilation / live / soundtrack / remix etc. — i.e. the original release,
/// not the reissues and hits collections MusicBrainz tends to list first.
fn release_penalty(r: &Release) -> u16 {
    let group = r.release_group.as_ref();
    let mut p: u16 = match group.and_then(|g| g.primary_type.as_deref()) {
        Some("Album") => 0,
        Some("EP") => 2,
        Some("Single") => 4,
        Some(_) => 6,
        None => 8,
    };
    // Secondary types mark non-original appearances — push them well down.
    if let Some(secs) = group.and_then(|g| g.secondary_types.as_ref()) {
        const DEMOTE: &[&str] = &[
            "Compilation",
            "Live",
            "Soundtrack",
            "Remix",
            "DJ-mix",
            "Mixtape/Street",
            "Interview",
            "Demo",
        ];
        if secs.iter().any(|s| DEMOTE.contains(&s.as_str())) {
            p += 20;
        }
    }
    // Prefer releases MusicBrainz marks Official over promos/bootlegs.
    match r.status.as_deref() {
        Some("Official") => {}
        Some(_) => p += 8,
        None => p += 4,
    }
    // A release with no date at all is a weak "original album" signal.
    if year_of(r) == i64::MAX {
        p += 2;
    }
    p
}

/// Best release within one recording: lowest penalty, then earliest year.
fn best_release(releases: &[Release]) -> Option<&Release> {
    releases
        .iter()
        .min_by(|a, b| {
            release_penalty(a)
                .cmp(&release_penalty(b))
                .then(year_of(a).cmp(&year_of(b)))
        })
}

/// Fetch a release-group's original (`first-release-date`) year. The search
/// endpoint omits this field and often lists only a reissue pressing, so this
/// follow-up is how we recover e.g. 1991 for any pressing of *Nevermind*.
async fn release_group_first_year(rg_id: &str) -> Option<i64> {
    let resp = http()
        .get(format!("https://musicbrainz.org/ws/2/release-group/{rg_id}"))
        .query(&[("fmt", "json")])
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    parse_year(v.get("first-release-date").and_then(|x| x.as_str()))
}

fn cover_art_url(release_group_id: &str) -> String {
    // Release-group front cover is the most representative; -500 is a sane size.
    format!("https://coverartarchive.org/release-group/{release_group_id}/front-500")
}

/// Strip a YouTube channel/uploader suffix from an artist so a stored label
/// like "Bush - Topic" or "CrashTestDummiesVEVO" still matches MusicBrainz.
fn sanitize_artist(a: &str) -> String {
    let mut a = a.trim();
    for suffix in [" - Topic", " - topic", " — Topic"] {
        if let Some(stripped) = a.strip_suffix(suffix) {
            a = stripped.trim();
        }
    }
    if a.to_lowercase().ends_with("vevo") && a.len() > 4 {
        a = a[..a.len() - 4].trim_end_matches([' ', '-', '_']).trim();
    }
    a.to_string()
}

/// Drop bracketed qualifiers — "(Remastered 2014)", "[Official Video]", "(HD)"
/// — from a title so the query matches the canonical recording.
fn sanitize_title(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut depth = 0i32;
    for ch in t.chars() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Look up a recording by artist + title. Returns a suggestion when a
/// confident match is found. `artist` may be empty (title-only search). Inputs
/// are sanitized first, so messy YouTube-derived labels still resolve.
pub async fn lookup(artist: &str, title: &str) -> Result<Option<MetadataSuggestion>, String> {
    let title_clean = sanitize_title(title);
    let title = if title_clean.is_empty() { title.trim() } else { title_clean.as_str() };
    if title.is_empty() {
        return Ok(None);
    }
    let artist_clean = sanitize_artist(artist);
    let artist = artist_clean.as_str();
    let query = if artist.is_empty() {
        format!("recording:\"{}\"", escape(title))
    } else {
        format!(
            "artist:\"{}\" AND recording:\"{}\"",
            escape(artist),
            escape(title)
        )
    };

    let resp = http()
        .get("https://musicbrainz.org/ws/2/recording")
        .query(&[
            ("query", query.as_str()),
            ("fmt", "json"),
            ("limit", "25"),
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

    // Among strong text matches, pick the recording whose best release is the
    // most "original studio album"-like — otherwise MusicBrainz's first result
    // is often a compilation/live appearance of the same song.
    let recordings = body.recordings.unwrap_or_default();
    let Some(best) = recordings
        .into_iter()
        .filter(|r| r.score.unwrap_or(0) >= 80)
        .min_by_key(|r| {
            let rel_penalty = r
                .releases
                .as_deref()
                .and_then(best_release)
                .map(release_penalty)
                .unwrap_or(u16::MAX);
            let year = r
                .releases
                .as_deref()
                .and_then(best_release)
                .map(year_of)
                .unwrap_or(i64::MAX);
            // primarily the most album-like release, then earliest, then
            // strongest text score (negated so higher score sorts first).
            (rel_penalty, year, -(r.score.unwrap_or(0)))
        })
    else {
        return Ok(None); // no match strong enough without the fingerprint/LLM tiers
    };
    let score = best.score.unwrap_or(0);

    let mut suggestion = MetadataSuggestion {
        title: best.title.clone(),
        artist: best
            .artist_credit
            .as_ref()
            .and_then(|cs| cs.first())
            .and_then(|c| c.name.clone()),
        musicbrainz_id: best.id.clone(),
        source: "musicbrainz".into(),
        confidence: (score as f32 / 100.0).min(1.0),
        ..Default::default()
    };

    if let Some(release) = best.releases.as_deref().and_then(best_release) {
        suggestion.year = release_year(release);
        if let Some(group) = &release.release_group {
            suggestion.album = group.title.clone();
            if let Some(gid) = &group.id {
                suggestion.art_url = Some(cover_art_url(gid));
                // Prefer the album's original year over this pressing's date.
                if let Some(y) = release_group_first_year(gid).await {
                    suggestion.year = Some(y);
                }
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
        suggestion.year = release_year(release);
        if let Some(group) = &release.release_group {
            suggestion.album = group.title.clone();
            if let Some(gid) = &group.id {
                suggestion.art_url = Some(cover_art_url(gid));
                // Prefer the album's original year over this pressing's date, so
                // a fingerprint match to a reissue still reports the first release.
                if let Some(y) = release_group_first_year(gid).await {
                    suggestion.year = Some(y);
                }
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
    fn sanitizes_youtube_artist_and_title_noise() {
        // The reported failing case: "Bush - Topic" / "Machinehead (Remastered 2014)".
        assert_eq!(sanitize_artist("Bush - Topic"), "Bush");
        assert_eq!(sanitize_artist("CrashTestDummiesVEVO"), "CrashTestDummies");
        assert_eq!(sanitize_artist("Bush"), "Bush");
        assert_eq!(sanitize_title("Machinehead (Remastered 2014)"), "Machinehead");
        assert_eq!(sanitize_title("Song [Official Video] (HD)"), "Song");
        assert_eq!(sanitize_title("Plain Title"), "Plain Title");
    }

    fn rel(
        id: &str,
        date: &str,
        primary: &str,
        secondary: Option<&str>,
        status: &str,
    ) -> Release {
        Release {
            id: Some(id.into()),
            date: Some(date.into()),
            status: Some(status.into()),
            release_group: Some(ReleaseGroup {
                id: Some(format!("g-{id}")),
                primary_type: Some(primary.into()),
                secondary_types: secondary.map(|s| vec![s.into()]),
                first_release_date: Some(date.into()),
                title: Some(id.into()),
            }),
        }
    }

    #[test]
    fn best_release_prefers_official_original_studio_album() {
        let releases = vec![
            rel("live", "1994-01-01", "Album", Some("Live"), "Official"),
            // A *later* official studio album reissue.
            rel("reissue", "2009-01-01", "Album", None, "Official"),
            // The original official studio album.
            rel("orig", "1984-07-16", "Album", None, "Official"),
            // A greatest-hits compilation (must lose despite being an "Album").
            rel("hits", "1990-01-01", "Album", Some("Compilation"), "Official"),
        ];
        let best = best_release(&releases).unwrap();
        assert_eq!(best.id.as_deref(), Some("orig"));
    }

    #[test]
    fn compilation_album_loses_to_a_plain_single() {
        let releases = vec![
            rel("comp", "2019-01-01", "Album", Some("Compilation"), "Official"),
            rel("single", "1991-09-10", "Single", None, "Official"),
        ];
        // The compilation's +20 secondary penalty outweighs Single's +4.
        assert_eq!(best_release(&releases).unwrap().id.as_deref(), Some("single"));
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
