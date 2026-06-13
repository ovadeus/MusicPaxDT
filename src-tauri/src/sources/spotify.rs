//! Spotify source — metadata only, via the official Web API with the user's
//! client credentials. STACK never touches Spotify audio (hard rule); a
//! playlist here is just a shopping list for the Mirror Engine to resolve to
//! official YouTube embeds.

use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct ListedTrack {
    pub title: String,
    pub artist: String,
    pub duration_ms: Option<u64>,
}

/// Extract a playlist id from open.spotify.com/playlist/... or spotify:playlist:...
pub fn parse_playlist_id(input: &str) -> Option<String> {
    let input = input.trim();
    let is_id = |s: &str| (16..=32).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric());
    if let Some(rest) = input.strip_prefix("spotify:playlist:") {
        return is_id(rest).then(|| rest.to_string());
    }
    if let Some(idx) = input.find("open.spotify.com/playlist/") {
        let id: String = input[idx + "open.spotify.com/playlist/".len()..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        return is_id(&id).then_some(id);
    }
    None
}

/// Client-credentials token (no user scope needed for public playlists).
pub async fn access_token(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
) -> Result<String, String> {
    use base64::Engine;
    #[derive(Deserialize)]
    struct TokenResp {
        access_token: Option<String>,
        error_description: Option<String>,
    }
    let basic = base64::engine::general_purpose::STANDARD
        .encode(format!("{client_id}:{client_secret}"));
    let resp: TokenResp = client
        .post("https://accounts.spotify.com/api/token")
        .header("Authorization", format!("Basic {basic}"))
        .form(&[("grant_type", "client_credentials")])
        .send()
        .await
        .map_err(|e| format!("Spotify token request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Spotify token parse failed: {e}"))?;
    resp.access_token.ok_or_else(|| {
        format!(
            "Spotify rejected the credentials: {}",
            resp.error_description.unwrap_or_else(|| "unknown error".into())
        )
    })
}

/// Fetch a playlist's name and full track list (paginated).
pub async fn playlist_tracks(
    client: &reqwest::Client,
    token: &str,
    playlist_id: &str,
) -> Result<(String, Vec<ListedTrack>), String> {
    #[derive(Deserialize)]
    struct Playlist {
        name: String,
    }
    #[derive(Deserialize)]
    struct Page {
        items: Vec<Item>,
        next: Option<String>,
    }
    #[derive(Deserialize)]
    struct Item {
        track: Option<TrackObj>,
    }
    #[derive(Deserialize)]
    struct TrackObj {
        name: String,
        artists: Vec<Artist>,
        duration_ms: Option<u64>,
        #[serde(rename = "type")]
        kind: Option<String>,
    }
    #[derive(Deserialize)]
    struct Artist {
        name: String,
    }

    let auth = format!("Bearer {token}");
    let meta = client
        .get(format!(
            "https://api.spotify.com/v1/playlists/{playlist_id}?fields=name"
        ))
        .header("Authorization", &auth)
        .send()
        .await
        .map_err(|e| format!("Spotify playlist request failed: {e}"))?;
    if !meta.status().is_success() {
        return Err(format!(
            "Spotify playlist not found or not public (HTTP {})",
            meta.status()
        ));
    }
    let name = meta
        .json::<Playlist>()
        .await
        .map_err(|e| format!("Spotify playlist parse failed: {e}"))?
        .name;

    let mut tracks = Vec::new();
    let mut url = Some(format!(
        "https://api.spotify.com/v1/playlists/{playlist_id}/tracks?limit=100&fields=next,items(track(name,type,duration_ms,artists(name)))"
    ));
    while let Some(page_url) = url.take() {
        let page: Page = client
            .get(&page_url)
            .header("Authorization", &auth)
            .send()
            .await
            .map_err(|e| format!("Spotify tracks request failed: {e}"))?
            .json()
            .await
            .map_err(|e| format!("Spotify tracks parse failed: {e}"))?;
        for item in page.items {
            if let Some(t) = item.track {
                // Skip local files / episodes — only resolvable music tracks.
                if t.kind.as_deref() == Some("track") || t.kind.is_none() {
                    tracks.push(ListedTrack {
                        title: t.name,
                        artist: t
                            .artists
                            .iter()
                            .map(|a| a.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", "),
                        duration_ms: t.duration_ms,
                    });
                }
            }
        }
        url = page.next;
        if tracks.len() >= 500 {
            break; // sanity cap
        }
    }
    Ok((name, tracks))
}

/// Parse a pasted text list: "Artist - Title" lines, or Exportify-style CSV
/// with "Track Name" / "Artist Name(s)" columns.
pub fn parse_text_list(text: &str) -> Vec<ListedTrack> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return Vec::new();
    }

    // CSV with a header row?
    let header = lines[0].to_lowercase();
    if header.contains("track name") && header.contains("artist") {
        let cols = split_csv_line(lines[0]);
        let find = |needle: &str| {
            cols.iter()
                .position(|c| c.to_lowercase().contains(needle))
        };
        if let (Some(title_idx), Some(artist_idx)) = (find("track name"), find("artist")) {
            return lines[1..]
                .iter()
                .filter_map(|line| {
                    let fields = split_csv_line(line);
                    let title = fields.get(title_idx)?.trim().to_string();
                    let artist = fields.get(artist_idx)?.trim().to_string();
                    (!title.is_empty()).then_some(ListedTrack {
                        title,
                        artist,
                        duration_ms: None,
                    })
                })
                .collect();
        }
    }

    // Plain "Artist - Title" (or "Artist – Title") lines.
    lines
        .iter()
        .filter_map(|line| {
            let (artist, title) = line
                .split_once(" - ")
                .or_else(|| line.split_once(" – "))
                .unwrap_or(("", line));
            let title = title.trim();
            (!title.is_empty()).then_some(ListedTrack {
                title: title.to_string(),
                artist: artist.trim().to_string(),
                duration_ms: None,
            })
        })
        .collect()
}

/// Minimal CSV field splitter (handles quoted fields with commas).
fn split_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                fields.push(std::mem::take(&mut field));
            }
            _ => field.push(c),
        }
    }
    fields.push(field);
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_playlist_urls() {
        assert_eq!(
            parse_playlist_id("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x"),
            Some("37i9dQZF1DXcBWIGoYBM5M".into())
        );
        assert_eq!(
            parse_playlist_id("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"),
            Some("37i9dQZF1DXcBWIGoYBM5M".into())
        );
        assert_eq!(parse_playlist_id("https://open.spotify.com/track/abc"), None);
    }

    #[test]
    fn parses_artist_title_lines() {
        let list = parse_text_list("Led Zeppelin - Kashmir\nPink Floyd – Time\n\nJustATitle");
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].artist, "Led Zeppelin");
        assert_eq!(list[0].title, "Kashmir");
        assert_eq!(list[1].artist, "Pink Floyd");
        assert_eq!(list[2].artist, "");
        assert_eq!(list[2].title, "JustATitle");
    }

    #[test]
    fn parses_exportify_csv() {
        let csv = "\"Track URI\",\"Track Name\",\"Artist Name(s)\",\"Album Name\"\n\
                   \"spotify:track:x\",\"Kashmir - Remaster\",\"Led Zeppelin\",\"Physical Graffiti\"\n\
                   \"spotify:track:y\",\"Time, Pt. 1\",\"Pink Floyd\",\"DSOTM\"";
        let list = parse_text_list(csv);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].title, "Kashmir - Remaster");
        assert_eq!(list[1].title, "Time, Pt. 1");
        assert_eq!(list[1].artist, "Pink Floyd");
    }
}
