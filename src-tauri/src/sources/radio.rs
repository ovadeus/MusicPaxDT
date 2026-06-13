//! M3: internet radio via the Radio Browser API (api.radio-browser.info) — a
//! community-run, open directory. No API key. Stations are STREAM_PLAYABLE:
//! the app plays the stream URL inline, never decoding it into the OWNED
//! mixing engine, and never records it.

use serde::{Deserialize, Serialize};

use crate::net::http;

// Radio Browser runs several mirror servers; any can serve the whole API.
// We try them in order so a single mirror outage isn't fatal.
const MIRRORS: &[&str] = &[
    "https://de1.api.radio-browser.info",
    "https://nl1.api.radio-browser.info",
    "https://at1.api.radio-browser.info",
    "https://fi1.api.radio-browser.info",
];

/// A station as the UI consumes it (camelCase for the frontend).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadioStation {
    pub uuid: String,
    pub name: String,
    pub url: String,
    pub favicon: Option<String>,
    pub tags: Option<String>,
    pub country: Option<String>,
    pub codec: Option<String>,
    pub bitrate: u32,
}

/// Raw Radio Browser station shape (subset).
#[derive(Debug, Deserialize)]
struct RawStation {
    stationuuid: Option<String>,
    name: Option<String>,
    url_resolved: Option<String>,
    url: Option<String>,
    favicon: Option<String>,
    tags: Option<String>,
    countrycode: Option<String>,
    codec: Option<String>,
    #[serde(default)]
    bitrate: u32,
}

impl RawStation {
    fn into_station(self) -> Option<RadioStation> {
        let url = self
            .url_resolved
            .filter(|u| !u.is_empty())
            .or(self.url)
            .filter(|u| !u.is_empty())?;
        let name = self.name.unwrap_or_default();
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        Some(RadioStation {
            uuid: self.stationuuid.unwrap_or_default(),
            name: name.to_string(),
            url,
            favicon: self.favicon.filter(|s| !s.is_empty()),
            tags: self.tags.filter(|s| !s.is_empty()),
            country: self.countrycode.filter(|s| !s.is_empty()),
            codec: self.codec.filter(|s| !s.is_empty()),
            bitrate: self.bitrate,
        })
    }
}

/// GET `path` from the first mirror that answers, deserializing the JSON body.
async fn get_json<T: for<'de> Deserialize<'de>>(path: &str) -> Result<T, String> {
    let mut last_err = String::from("no radio mirrors configured");
    for base in MIRRORS {
        let url = format!("{base}{path}");
        match http().get(&url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.json::<T>().await {
                Ok(v) => return Ok(v),
                Err(e) => last_err = format!("parse failed ({base}): {e}"),
            },
            Ok(resp) => last_err = format!("{base} returned HTTP {}", resp.status()),
            Err(e) => last_err = format!("{base} unreachable: {e}"),
        }
    }
    Err(format!("Radio Browser unavailable: {last_err}"))
}

fn dedupe_and_collect(raw: Vec<RawStation>) -> Vec<RadioStation> {
    let mut out = Vec::with_capacity(raw.len());
    let mut seen = std::collections::HashSet::new();
    for s in raw {
        if let Some(station) = s.into_station() {
            // Collapse duplicate stream URLs the directory often lists twice.
            if seen.insert(station.url.clone()) {
                out.push(station);
            }
        }
    }
    out
}

/// Most-clicked stations — a sensible default browse list.
pub async fn top(limit: u32) -> Result<Vec<RadioStation>, String> {
    let limit = limit.clamp(1, 100);
    let raw: Vec<RawStation> = get_json(&format!("/json/stations/topclick/{limit}")).await?;
    Ok(dedupe_and_collect(raw))
}

/// Search by name (and tags, which Radio Browser folds into the name query).
pub async fn search(query: &str, limit: u32) -> Result<Vec<RadioStation>, String> {
    let q = query.trim();
    if q.is_empty() {
        return top(limit).await;
    }
    let limit = limit.clamp(1, 100);
    // `name` search with broken stations hidden, ordered by popularity.
    let encoded = urlencoding(q);
    let path = format!(
        "/json/stations/search?name={encoded}&limit={limit}&order=clickcount&reverse=true&hidebroken=true"
    );
    let raw: Vec<RawStation> = get_json(&path).await?;
    Ok(dedupe_and_collect(raw))
}

/// Minimal percent-encoding for a query value (the API is permissive, but
/// spaces and `&`/`?`/`#`/`%`/`+` must not break the URL).
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encodes_query_safely() {
        assert_eq!(urlencoding("jazz & blues"), "jazz%20%26%20blues");
        assert_eq!(urlencoding("KEXP"), "KEXP");
        assert_eq!(urlencoding("c#"), "c%23");
    }

    #[test]
    fn prefers_resolved_url_and_skips_nameless() {
        let raw = vec![
            RawStation {
                stationuuid: Some("a".into()),
                name: Some("KEXP".into()),
                url_resolved: Some("https://kexp.example/stream".into()),
                url: Some("https://kexp.example/old".into()),
                favicon: Some("".into()),
                tags: Some("indie".into()),
                countrycode: Some("US".into()),
                codec: Some("MP3".into()),
                bitrate: 128,
            },
            RawStation {
                stationuuid: Some("b".into()),
                name: Some("   ".into()), // nameless → dropped
                url_resolved: Some("https://x/stream".into()),
                url: None,
                favicon: None,
                tags: None,
                countrycode: None,
                codec: None,
                bitrate: 0,
            },
        ];
        let out = dedupe_and_collect(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].url, "https://kexp.example/stream");
        assert_eq!(out[0].favicon, None); // empty string filtered to None
    }

    #[test]
    fn dedupes_identical_stream_urls() {
        let mk = |uuid: &str| RawStation {
            stationuuid: Some(uuid.into()),
            name: Some("Dup".into()),
            url_resolved: Some("https://same/stream".into()),
            url: None,
            favicon: None,
            tags: None,
            countrycode: None,
            codec: None,
            bitrate: 0,
        };
        assert_eq!(dedupe_and_collect(vec![mk("a"), mk("b")]).len(), 1);
    }

    /// Live search against Radio Browser. Network-gated.
    #[tokio::test]
    #[ignore = "requires network access"]
    async fn live_search_returns_stations() {
        let stations = search("KEXP", 10).await.expect("search ok");
        assert!(!stations.is_empty(), "KEXP should match something");
        assert!(stations.iter().all(|s| s.url.starts_with("http")));
    }
}
