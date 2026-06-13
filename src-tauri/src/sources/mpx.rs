//! Importer for MusicPax `.mpx` playlist files. Despite the custom extension
//! the current export format is plain UTF-8 JSON. A legacy build could emit an
//! AES-encrypted binary starting with the ASCII magic `MPAX`; we detect that
//! and report it rather than guessing. Plain JSON is the primary path.

use serde::Deserialize;

/// One normalized track ready to map onto the library.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportTrack {
    pub position: i64,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<i64>,
    pub cover: Option<String>,
    /// Resolved playable URL: sourceUrl → streamUrl → originalUrl. None = skip.
    pub url: Option<String>,
    pub source_type: Option<String>,
    pub category: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ImportPlaylist {
    pub name: String,
    pub description: Option<String>,
    /// Tracks sorted by `position` ascending.
    pub tracks: Vec<ImportTrack>,
    /// Non-fatal notes for the user (e.g. empty playlist).
    pub warnings: Vec<String>,
}

// --- raw JSON shapes (current plain-JSON format) --------------------------

#[derive(Deserialize)]
struct RawFile {
    playlist: Option<RawPlaylist>,
    tracks: Option<Vec<RawItem>>,
}

#[derive(Deserialize)]
struct RawPlaylist {
    name: Option<String>,
    description: Option<String>,
}

#[derive(Deserialize)]
struct RawItem {
    #[serde(default)]
    position: i64,
    media: Option<RawMedia>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawMedia {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    year: Option<serde_json::Value>,
    thumbnail: Option<String>,
    cover_image: Option<String>,
    source_url: Option<String>,
    stream_url: Option<String>,
    original_url: Option<String>,
    source_type: Option<String>,
    category: Option<String>,
    duration: Option<serde_json::Value>,
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Coerce a string|number JSON value into a 4-digit year.
fn coerce_year(v: Option<&serde_json::Value>) -> Option<i64> {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_i64().filter(|y| (1000..=9999).contains(y)),
        Some(serde_json::Value::String(s)) => s
            .trim()
            .get(0..4)
            .and_then(|y| y.parse::<i64>().ok())
            .filter(|y| (1000..=9999).contains(y)),
        _ => None,
    }
}

/// Coerce a number|string seconds value into milliseconds.
fn coerce_duration_ms(v: Option<&serde_json::Value>) -> Option<i64> {
    let secs = match v {
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        Some(serde_json::Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    (secs > 0.0).then(|| (secs * 1000.0).round() as i64)
}

fn normalize_media(position: i64, m: RawMedia) -> ImportTrack {
    let url = clean(m.source_url)
        .or_else(|| clean(m.stream_url))
        .or_else(|| clean(m.original_url));
    let cover = clean(m.cover_image).or_else(|| clean(m.thumbnail));
    ImportTrack {
        position,
        title: clean(m.title),
        artist: clean(m.artist),
        album: clean(m.album),
        year: coerce_year(m.year.as_ref()),
        cover,
        url,
        source_type: clean(m.source_type).map(|s| s.to_lowercase()),
        category: clean(m.category),
        duration_ms: coerce_duration_ms(m.duration.as_ref()),
    }
}

/// Parse a `.mpx` file's bytes into a normalized playlist. Returns a friendly
/// error for the legacy encrypted format and for malformed JSON.
pub fn parse_mpx(bytes: &[u8]) -> Result<ImportPlaylist, String> {
    if bytes.starts_with(b"MPAX") {
        return Err(
            "This is a legacy encrypted .mpx (older MusicPax export). This build imports the \
             current plain-JSON .mpx — re-export the playlist from MusicPax, or ask to enable \
             legacy decryption."
                .into(),
        );
    }

    let raw: RawFile = serde_json::from_slice(bytes)
        .map_err(|e| format!("not a valid .mpx (JSON parse failed): {e}"))?;

    let playlist = raw
        .playlist
        .ok_or("invalid .mpx: missing the \"playlist\" object")?;
    let name = clean(playlist.name).unwrap_or_else(|| "Imported playlist".to_string());

    let mut warnings = Vec::new();
    let mut tracks: Vec<ImportTrack> = match raw.tracks {
        Some(items) if !items.is_empty() => items
            .into_iter()
            .filter_map(|item| item.media.map(|m| normalize_media(item.position, m)))
            .collect(),
        _ => {
            warnings.push("the file contained no tracks — imported an empty playlist".into());
            Vec::new()
        }
    };
    // Stable sort by position so equal/missing positions keep file order.
    tracks.sort_by_key(|t| t.position);

    Ok(ImportPlaylist {
        name,
        description: clean(playlist.description),
        tracks,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE: &str = r#"{
      "playlist": {
        "name": "Road Trip Hits",
        "description": "Summer 2025",
        "id": 42,
        "isPrivate": false,
        "dateCreated": "2025-07-01T12:00:00.000Z",
        "playlistUrl": null
      },
      "tracks": [
        {
          "id": 1001, "playlistId": 42, "mediaId": 2001, "position": 1,
          "media": {
            "id": 2002,
            "title": "Second By Position",
            "artist": "B",
            "sourceUrl": "https://www.youtube.com/watch?v=bbbbbbbbbbb",
            "sourceType": "youtube",
            "category": "music",
            "duration": 100,
            "year": "2001"
          }
        },
        {
          "id": 1000, "playlistId": 42, "mediaId": 2001, "position": 0,
          "media": {
            "id": 2001,
            "title": "Mr. Blue Sky",
            "artist": "Electric Light Orchestra",
            "album": "Out of the Blue",
            "year": "1977",
            "thumbnail": "https://i.ytimg.com/vi/aQUlA8Hcv4s/hqdefault.jpg",
            "coverImage": "https://i.ytimg.com/vi/aQUlA8Hcv4s/maxresdefault.jpg",
            "sourceUrl": "https://www.youtube.com/watch?v=aQUlA8Hcv4s",
            "streamUrl": null,
            "originalUrl": "https://www.youtube.com/watch?v=aQUlA8Hcv4s",
            "sourceType": "youtube",
            "category": "music",
            "duration": 303,
            "isPublic": true, "isPrivate": false, "isActive": true
          }
        }
      ]
    }"#;

    #[test]
    fn parses_example_and_sorts_by_position() {
        let p = parse_mpx(EXAMPLE.as_bytes()).expect("parse");
        assert_eq!(p.name, "Road Trip Hits");
        assert_eq!(p.description.as_deref(), Some("Summer 2025"));
        assert_eq!(p.tracks.len(), 2);

        // position 0 must come first despite appearing second in the file.
        let first = &p.tracks[0];
        assert_eq!(first.title.as_deref(), Some("Mr. Blue Sky"));
        assert_eq!(first.artist.as_deref(), Some("Electric Light Orchestra"));
        assert_eq!(first.album.as_deref(), Some("Out of the Blue"));
        assert_eq!(first.year, Some(1977));
        assert_eq!(first.duration_ms, Some(303_000));
        assert_eq!(
            first.url.as_deref(),
            Some("https://www.youtube.com/watch?v=aQUlA8Hcv4s")
        );
        // Prefers coverImage over thumbnail.
        assert_eq!(
            first.cover.as_deref(),
            Some("https://i.ytimg.com/vi/aQUlA8Hcv4s/maxresdefault.jpg")
        );
        assert_eq!(p.tracks[1].title.as_deref(), Some("Second By Position"));
        assert!(p.warnings.is_empty());
    }

    #[test]
    fn falls_back_through_url_fields_and_skips_blank() {
        let json = r#"{"playlist":{"name":"X"},"tracks":[
            {"position":0,"media":{"title":"only original","sourceUrl":"","streamUrl":null,"originalUrl":"https://o/x"}},
            {"position":1,"media":{"title":"stream","streamUrl":"https://s/y"}},
            {"position":2,"media":{"title":"no url"}}
        ]}"#;
        let p = parse_mpx(json.as_bytes()).unwrap();
        assert_eq!(p.tracks[0].url.as_deref(), Some("https://o/x"));
        assert_eq!(p.tracks[1].url.as_deref(), Some("https://s/y"));
        assert_eq!(p.tracks[2].url, None); // caller skips this one
    }

    #[test]
    fn empty_tracks_warns_not_errors() {
        let p = parse_mpx(br#"{"playlist":{"name":"Empty"},"tracks":[]}"#).unwrap();
        assert_eq!(p.name, "Empty");
        assert!(p.tracks.is_empty());
        assert_eq!(p.warnings.len(), 1);
    }

    #[test]
    fn legacy_magic_is_reported() {
        let mut bytes = b"MPAX".to_vec();
        bytes.extend_from_slice(&[1, 0, 0]);
        assert!(parse_mpx(&bytes).unwrap_err().contains("legacy"));
    }

    #[test]
    fn malformed_json_errors() {
        assert!(parse_mpx(b"not json").is_err());
        assert!(parse_mpx(br#"{"tracks":[]}"#).unwrap_err().contains("playlist"));
    }
}
