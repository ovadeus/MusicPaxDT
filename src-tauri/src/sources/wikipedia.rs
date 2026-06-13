//! Artist mini-biographies from Wikipedia's free REST summary endpoint
//! (no API key). Used by the Now Playing panel.

use serde::{Deserialize, Serialize};

use crate::net::http;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistBio {
    pub extract: String,
    pub thumbnail: Option<String>,
    pub url: Option<String>,
    pub title: String,
}

#[derive(Deserialize)]
struct Summary {
    #[serde(rename = "type")]
    kind: Option<String>,
    title: Option<String>,
    extract: Option<String>,
    thumbnail: Option<Thumb>,
    content_urls: Option<ContentUrls>,
}
#[derive(Deserialize)]
struct Thumb {
    source: Option<String>,
}
#[derive(Deserialize)]
struct ContentUrls {
    desktop: Option<Desktop>,
}
#[derive(Deserialize)]
struct Desktop {
    page: Option<String>,
}

/// Title candidates to try, in order — musicians often live at a
/// disambiguated title rather than the bare name.
pub fn title_candidates(artist: &str) -> Vec<String> {
    let a = artist.trim();
    vec![
        a.to_string(),
        format!("{a} (musician)"),
        format!("{a} (band)"),
        format!("{a} (singer)"),
    ]
}

fn encode_title(title: &str) -> String {
    // The REST endpoint wants spaces as underscores; percent-encode the rest.
    title
        .trim()
        .split(' ')
        .map(|seg| {
            seg.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'(' | b')' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{b:02X}"),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("_")
}

/// Fetch the first usable artist summary. `None` when nothing suitable is found.
pub async fn artist_bio(artist: &str) -> Result<Option<ArtistBio>, String> {
    let artist = artist.trim();
    if artist.is_empty() {
        return Ok(None);
    }
    for title in title_candidates(artist) {
        let url = format!(
            "https://en.wikipedia.org/api/rest_v1/page/summary/{}",
            encode_title(&title)
        );
        let resp = match http().get(&url).send().await {
            Ok(r) => r,
            Err(e) => return Err(format!("Wikipedia request failed: {e}")),
        };
        if !resp.status().is_success() {
            continue; // 404 for this candidate — try the next
        }
        let s: Summary = match resp.json().await {
            Ok(s) => s,
            Err(_) => continue,
        };
        // Skip disambiguation pages and empty extracts.
        if s.kind.as_deref() == Some("disambiguation") {
            continue;
        }
        let extract = s.extract.unwrap_or_default();
        if extract.trim().is_empty() {
            continue;
        }
        return Ok(Some(ArtistBio {
            extract,
            thumbnail: s.thumbnail.and_then(|t| t.source),
            url: s.content_urls.and_then(|c| c.desktop).and_then(|d| d.page),
            title: s.title.unwrap_or_else(|| title.clone()),
        }));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_title_candidates() {
        let c = title_candidates("Queen");
        assert_eq!(c[0], "Queen");
        assert!(c.contains(&"Queen (band)".to_string()));
    }

    #[test]
    fn encodes_titles_with_underscores() {
        assert_eq!(encode_title("Electric Light Orchestra"), "Electric_Light_Orchestra");
        assert_eq!(encode_title("AC/DC"), "AC%2FDC");
        assert_eq!(encode_title("Sade (singer)"), "Sade_(singer)");
    }

    /// Live fetch — network-gated.
    #[tokio::test]
    #[ignore = "requires network access"]
    async fn fetches_a_known_artist() {
        let bio = artist_bio("Electric Light Orchestra")
            .await
            .expect("request ok")
            .expect("a summary");
        assert!(bio.extract.to_lowercase().contains("band") || !bio.extract.is_empty());
        assert!(bio.url.is_some());
    }
}
