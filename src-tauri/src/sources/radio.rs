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

// ---------------------------------------------------------------------------
// Custom stream resolver: turn a user-pasted link into a playable station.
// Handles direct audio URLs, .pls/.m3u playlists, HLS (.m3u8), and a
// best-effort scrape of a player page. Never downloads an audio body (those
// streams are infinite) — only headers, and text for playlist/HTML types.
// ---------------------------------------------------------------------------

fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or(url)
        .to_string()
}

fn looks_like_direct_audio(url: &str) -> bool {
    let u = url.split(['?', '#']).next().unwrap_or(url).to_lowercase();
    u.ends_with(".mp3")
        || u.ends_with(".aac")
        || u.ends_with(".ogg")
        || u.ends_with(".opus")
        || u.ends_with(".m3u8") // HLS — WebKit <audio> plays it directly
        || u.ends_with(".flac")
        || u.ends_with(';') // common Icecast/Shoutcast mount suffix
}

/// Extract every absolute http(s) URL from a blob of text.
fn extract_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut search = 0;
    while let Some(rel) = text[search..].find("http") {
        let start = search + rel;
        let rest = &text[start..];
        if rest.starts_with("http://") || rest.starts_with("https://") {
            let end = rest
                .find(|c: char| {
                    c.is_whitespace()
                        || matches!(c, '"' | '\'' | '<' | '>' | '\\' | ')' | '(' | ']' | '[' | '`')
                })
                .unwrap_or(rest.len());
            let url = rest[..end].trim_end_matches(['.', ',', ';']);
            if url.len() > 12 {
                urls.push(url.to_string());
            }
            search = start + end.max(4);
        } else {
            search = start + 4;
        }
    }
    urls
}

/// Choose the most stream-like URL from candidates.
fn pick_stream_url(urls: &[String]) -> Option<String> {
    let score = |u: &str| -> i32 {
        let l = u.to_lowercase();
        let is_audio_ext = l.contains(".m3u8")
            || l.ends_with(".mp3")
            || l.contains(".mp3?")
            || l.ends_with(".aac")
            || l.contains(".aac?")
            || l.ends_with(".opus");
        if is_audio_ext {
            5
        } else if l.contains("/stream") || l.contains("/listen") || l.contains("icecast") {
            3
        } else if l.contains(".pls") || l.contains(".m3u") {
            2
        } else {
            0
        }
    };
    urls.iter().filter(|u| score(u) > 0).max_by_key(|u| score(u)).cloned()
}

/// SoundStack / cdnstream1 (and similar) web players embed their stream as an
/// inline `streams = [{"format","host","id","https","port"}]` array. Build the
/// playable URL from it. This covers a large family of station player pages.
fn parse_player_streams(html: &str) -> Option<String> {
    let mut from = 0;
    while let Some(rel) = html[from..].find("streams") {
        let start = from + rel + "streams".len();
        from = start;
        let after = html[start..].trim_start();
        if !after.starts_with('=') {
            continue;
        }
        let after_eq = after[1..].trim_start();
        if !after_eq.starts_with('[') {
            continue;
        }
        // Slice the array literal: from '[' to the first ']' (objects use {}).
        let lb = html[start..].find('[')? + start;
        let rb = html[lb..].find(']')? + lb + 1;
        let arr: serde_json::Value = serde_json::from_str(&html[lb..rb]).ok()?;
        let first = arr.as_array()?.iter().find(|s| s.get("host").is_some())?;
        let host = first.get("host")?.as_str()?;
        let id = first.get("id")?.as_str()?;
        let https = matches!(first.get("https"), Some(v) if v.as_i64() == Some(1) || v.as_bool() == Some(true));
        let scheme = if https { "https" } else { "http" };
        let port = first.get("port").and_then(|v| v.as_i64()).unwrap_or(if https { 443 } else { 80 });
        let standard = (https && port == 443) || (!https && port == 80);
        return Some(if standard {
            format!("{scheme}://{host}/{id}")
        } else {
            format!("{scheme}://{host}:{port}/{id}")
        });
    }
    None
}

fn title_of(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let gt = lower[start..].find('>')? + start + 1;
    let end = lower[gt..].find("</title>")? + gt;
    let t = html[gt..end].trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// First playable URL from a .pls or .m3u/.m3u8 playlist body.
fn parse_playlist(body: &str, base_url: &str) -> Option<String> {
    for line in body.lines() {
        let line = line.trim();
        if let Some((_, url)) = line.strip_prefix("File").and_then(|r| r.split_once('=')) {
            let url = url.trim();
            if url.starts_with("http") {
                return Some(url.to_string());
            }
        }
    }
    if body.contains("#EXTM3U") && base_url.to_lowercase().contains("m3u8") {
        return Some(base_url.to_string());
    }
    body.lines()
        .map(str::trim)
        .find(|l| l.starts_with("http"))
        .map(|l| l.to_string())
}

fn codec_from_ctype(ctype: &str) -> Option<String> {
    if ctype.contains("mpeg") || ctype.contains("mp3") {
        Some("MP3".into())
    } else if ctype.contains("aac") {
        Some("AAC".into())
    } else if ctype.contains("ogg") {
        Some("OGG".into())
    } else {
        None
    }
}

fn custom_station(name: String, url: String, codec: Option<String>) -> RadioStation {
    let name = name.trim();
    RadioStation {
        uuid: String::new(),
        name: if name.is_empty() { host_of(&url) } else { name.to_string() },
        url,
        favicon: None,
        tags: Some("custom".into()),
        country: None,
        codec,
        bitrate: 0,
    }
}

/// Resolve a pasted link into a playable station (best effort). Never reads an
/// audio body (those are infinite streams) — only headers, plus text for
/// playlist/HTML content types.
pub async fn resolve_stream(input: &str) -> Result<RadioStation, String> {
    let input = input.trim();
    if !(input.starts_with("http://") || input.starts_with("https://")) {
        return Err("Enter a full http(s) stream or page URL.".into());
    }
    if looks_like_direct_audio(input) {
        return Ok(custom_station(host_of(input), input.to_string(), None));
    }

    let resp = http()
        .get(input)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach that URL: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("That URL returned HTTP {}.", resp.status()));
    }
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let icy_name = resp
        .headers()
        .get("icy-name")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Direct audio response: use the URL as-is, do NOT read the (endless) body.
    if ctype.starts_with("audio/") || ctype.contains("application/ogg") {
        return Ok(custom_station(
            icy_name.unwrap_or_else(|| host_of(input)),
            input.to_string(),
            codec_from_ctype(&ctype),
        ));
    }

    // Playlist or HTML → safe to read as text.
    let body = resp.text().await.map_err(|e| format!("Read failed: {e}"))?;

    if ctype.contains("mpegurl")
        || ctype.contains("scpls")
        || input.to_lowercase().contains(".pls")
        || input.to_lowercase().contains(".m3u")
        || body.trim_start().starts_with("[playlist]")
        || body.trim_start().starts_with("#EXTM3U")
    {
        if let Some(u) = parse_playlist(&body, input) {
            return Ok(custom_station(
                icy_name.unwrap_or_else(|| host_of(&u)),
                u,
                None,
            ));
        }
    }

    let name = icy_name.or_else(|| title_of(&body)).unwrap_or_else(|| host_of(input));
    // Prefer the player's embedded streams[] config (SoundStack/cdnstream1 etc.),
    // then fall back to scraping any stream-like URL from the page.
    if let Some(u) = parse_player_streams(&body) {
        return Ok(custom_station(name, u, None));
    }
    match pick_stream_url(&extract_urls(&body)) {
        Some(u) => Ok(custom_station(name, u, None)),
        None => Err(
            "Couldn't find an audio stream on that page. Paste the direct stream URL \
             (often ending in .mp3, .aac, or .m3u8) — usually found via the player's \
             “share” option or the page source."
                .into(),
        ),
    }
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
    fn direct_audio_urls_are_recognized() {
        assert!(looks_like_direct_audio("https://x/stream.mp3"));
        assert!(looks_like_direct_audio("https://x/hls/master.m3u8?x=1"));
        assert!(looks_like_direct_audio("https://x/listen;"));
        assert!(!looks_like_direct_audio("https://live.mystreamplayer.com/pmgkauai?autoplay=1"));
    }

    #[test]
    fn extracts_and_picks_the_stream_from_html() {
        let html = r#"<html><head><title>PMG Kauai</title></head>
            <body><script>var cfg={"poster":"https://cdn/img.png",
            "src":"https://live.mystreamplayer.com/pmgkauai/icecast.audio"};</script>
            <a href="https://example.com/about">about</a></body></html>"#;
        let urls = extract_urls(html);
        assert!(urls.iter().any(|u| u.contains("icecast.audio")));
        let pick = pick_stream_url(&urls).expect("a stream candidate");
        assert!(pick.contains("icecast.audio"));
        assert_eq!(title_of(html).as_deref(), Some("PMG Kauai"));
    }

    #[test]
    fn parses_soundstack_streams_array() {
        // The exact shape KONG FM's player page embeds.
        let html = r#"<script>cfg_yp_mount = "2788_64";
            streams = [{"format":"iceaac","host":"pacificmedia.cdnstream1.com","id":"2788_64.aac","https":1,"port":443}];
            master = 0;</script>"#;
        assert_eq!(
            parse_player_streams(html).as_deref(),
            Some("https://pacificmedia.cdnstream1.com/2788_64.aac"),
        );
    }

    #[test]
    fn soundstack_nonstandard_port_keeps_port() {
        let html = r#"streams = [{"format":"ice","host":"h.example.com","id":"live","https":0,"port":8000}];"#;
        assert_eq!(
            parse_player_streams(html).as_deref(),
            Some("http://h.example.com:8000/live"),
        );
    }

    #[test]
    fn parses_pls_and_m3u() {
        let pls = "[playlist]\nNumberOfEntries=1\nFile1=https://cdn/stream.mp3\n";
        assert_eq!(parse_playlist(pls, "x").as_deref(), Some("https://cdn/stream.mp3"));
        let m3u = "#EXTM3U\n#EXTINF:-1,Station\nhttps://cdn/live.aac\n";
        assert_eq!(parse_playlist(m3u, "x").as_deref(), Some("https://cdn/live.aac"));
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
