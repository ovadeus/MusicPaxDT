//! Exporter for MusicPax `.mpx` playlist files — the mirror of `mpx.rs`'s
//! importer. Emits the flat plain-JSON shape (`{name, description, items}`)
//! so an exported playlist round-trips through `parse_mpx` unchanged.
//!
//! Only web-playable REFERENCES travel: OWNED/local tracks are excluded — their
//! uri is a filesystem path the recipient can't resolve, and shipping owned
//! audio itself would be distribution, which the capability rules forbid.

use serde::Serialize;

use crate::library::model::{Capability, Track};

/// What the exporter kept vs left behind (surfaced in the share UI).
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStats {
    pub included: usize,
    pub excluded_local: usize,
}

// --- serialize shapes: the importer's flat format ---------------------------
// Field names/casing mirror `mpx.rs::RawMedia` (camelCase on the wire).
// `duration` is SECONDS (float) — the importer multiplies by 1000 and rounds,
// so emitting duration_ms / 1000.0 preserves exact milliseconds.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportMedia<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artist: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    album: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    year: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail: Option<&'a str>,
    source_url: &'a str,
    source_type: &'a str,
    /// Carries the track's genre — the importer maps `category` back to genre.
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<f64>,
}

#[derive(Serialize)]
struct ExportItem<'a> {
    position: i64,
    media: ExportMedia<'a>,
}

#[derive(Serialize)]
struct ExportFile<'a> {
    version: u32,
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<&'a str>,
    items: Vec<ExportItem<'a>>,
}

fn is_http(uri: &str) -> bool {
    uri.starts_with("http://") || uri.starts_with("https://")
}

/// Serialize a playlist's tracks (already in curated order) into the flat
/// `.mpx` JSON. Tracks that can't travel (OWNED, or any non-http(s) uri) are
/// counted in `excluded_local` rather than emitted.
pub fn export_mpx(
    name: &str,
    description: Option<&str>,
    tracks: &[Track],
) -> (serde_json::Value, ExportStats) {
    let mut stats = ExportStats::default();
    let mut items: Vec<ExportItem> = Vec::with_capacity(tracks.len());

    for t in tracks {
        // Belt and suspenders: OWNED is never shareable, and any filesystem
        // uri (regardless of capability) is meaningless on another machine.
        if t.capability == Capability::Owned || !is_http(&t.uri) {
            stats.excluded_local += 1;
            continue;
        }
        items.push(ExportItem {
            position: items.len() as i64,
            media: ExportMedia {
                title: t.title.as_deref(),
                artist: t.artist.as_deref(),
                album: t.album.as_deref(),
                year: t.year,
                // Imported covers are remote URLs; a local art file can't travel.
                thumbnail: t.art_path.as_deref().filter(|p| is_http(p)),
                source_url: &t.uri,
                source_type: &t.source_kind,
                category: t.genre.as_deref(),
                duration: t.duration_ms.map(|ms| ms as f64 / 1000.0),
            },
        });
        stats.included += 1;
    }

    let file = ExportFile {
        version: 1,
        name,
        description,
        items,
    };
    // These structs serialize infallibly (string keys, no fallible impls);
    // fall back to Null rather than unwrap, per the no-unwrap rule.
    (serde_json::to_value(&file).unwrap_or_default(), stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::mpx::parse_mpx;

    fn track(
        id: i64,
        title: &str,
        uri: &str,
        kind: &str,
        capability: Capability,
    ) -> Track {
        Track {
            id,
            title: Some(title.into()),
            artist: Some(format!("{title} artist")),
            album: None,
            year: None,
            genre: None,
            bpm: None,
            musical_key: None,
            duration_ms: None,
            uri: uri.into(),
            source_kind: kind.into(),
            capability,
            media_type: "music".into(),
            fingerprint: None,
            musicbrainz_id: None,
            art_path: None,
            rating: 0,
            play_count: 0,
            added_at: 0,
        }
    }

    #[test]
    fn round_trips_through_the_importer() {
        let mut yt = track(
            1,
            "Mr. Blue Sky",
            "https://www.youtube.com/watch?v=aQUlA8Hcv4s",
            "youtube",
            Capability::StreamPlayable,
        );
        yt.album = Some("Out of the Blue".into());
        yt.year = Some(1977);
        yt.genre = Some("Rock".into());
        // Non-whole-second duration: must survive to the exact millisecond.
        yt.duration_ms = Some(303_500);
        yt.art_path = Some("https://i.ytimg.com/vi/aQUlA8Hcv4s/hqdefault.jpg".into());

        let radio = track(
            2,
            "KEXP",
            "https://kexp.example/stream",
            "radio",
            Capability::StreamPlayable,
        );
        let stream = track(
            3,
            "Archive Show",
            "https://archive.org/x.mp3",
            "stream",
            Capability::StreamPlayable,
        );
        let spotify = track(
            4,
            "Link Only",
            "https://open.spotify.com/track/abc",
            "spotify",
            Capability::LinkOnly,
        );
        // Local OWNED file — must be excluded, not exported.
        let mut local = track(5, "My Rip", "/music/rip.flac", "local", Capability::Owned);
        local.art_path = Some("/covers/rip.jpg".into()); // local art never travels

        let tracks = vec![yt, radio, stream, spotify, local];
        let (json, stats) = export_mpx("Road Trip", Some("Summer"), &tracks);
        assert_eq!(stats.included, 4);
        assert_eq!(stats.excluded_local, 1);

        let bytes = serde_json::to_vec(&json).unwrap();
        let p = parse_mpx(&bytes).expect("exported .mpx must parse");
        assert_eq!(p.name, "Road Trip");
        assert_eq!(p.description.as_deref(), Some("Summer"));
        assert_eq!(p.tracks.len(), 4);
        assert!(p.warnings.is_empty());

        let first = &p.tracks[0];
        assert_eq!(first.title.as_deref(), Some("Mr. Blue Sky"));
        assert_eq!(first.artist.as_deref(), Some("Mr. Blue Sky artist"));
        assert_eq!(first.album.as_deref(), Some("Out of the Blue"));
        assert_eq!(first.year, Some(1977));
        assert_eq!(first.duration_ms, Some(303_500), "ms must survive exactly");
        assert_eq!(
            first.url.as_deref(),
            Some("https://www.youtube.com/watch?v=aQUlA8Hcv4s")
        );
        assert_eq!(first.source_type.as_deref(), Some("youtube"));
        assert_eq!(first.category.as_deref(), Some("Rock")); // genre round-trip
        assert_eq!(
            first.cover.as_deref(),
            Some("https://i.ytimg.com/vi/aQUlA8Hcv4s/hqdefault.jpg")
        );

        // Order + kinds preserved; positions re-based 0..n.
        let kinds: Vec<_> = p
            .tracks
            .iter()
            .map(|t| t.source_type.as_deref().unwrap_or("").to_string())
            .collect();
        assert_eq!(kinds, ["youtube", "radio", "stream", "spotify"]);
        assert_eq!(
            p.tracks.iter().map(|t| t.position).collect::<Vec<_>>(),
            [0, 1, 2, 3]
        );
        // The local track's title must appear nowhere in the payload.
        assert!(!String::from_utf8(bytes).unwrap().contains("My Rip"));
    }

    #[test]
    fn all_local_playlist_exports_zero_tracks() {
        let tracks = vec![
            track(1, "A", "/music/a.flac", "local", Capability::Owned),
            track(2, "B", "/music/b.mp3", "local", Capability::Owned),
        ];
        let (json, stats) = export_mpx("Locals", None, &tracks);
        assert_eq!(stats.included, 0);
        assert_eq!(stats.excluded_local, 2);
        // Still a valid (empty) .mpx — the caller decides whether to refuse.
        let p = parse_mpx(&serde_json::to_vec(&json).unwrap()).unwrap();
        assert!(p.tracks.is_empty());
        assert_eq!(p.warnings.len(), 1);
    }

    #[test]
    fn omits_empty_fields_rather_than_emitting_nulls() {
        let bare = track(
            1,
            "Bare",
            "https://x.example/s.mp3",
            "stream",
            Capability::StreamPlayable,
        );
        let (json, _) = export_mpx("X", None, &[bare]);
        let media = &json["items"][0]["media"];
        assert!(media.get("album").is_none());
        assert!(media.get("year").is_none());
        assert!(media.get("thumbnail").is_none());
        assert!(media.get("duration").is_none());
        assert!(json.get("description").is_none());
    }
}
