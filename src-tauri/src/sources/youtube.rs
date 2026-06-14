//! YouTube source — official embeds only, always STREAM_PLAYABLE. The app
//! never touches YouTube audio streams: playback happens inside the official
//! IFrame player in the webview, and there is no downloading of any kind.

use serde::Deserialize;

/// Extract the 11-character video id from any common YouTube URL shape.
pub fn parse_video_id(url: &str) -> Option<String> {
    let url = url.trim();
    let is_id = |s: &str| s.len() == 11 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');

    let lowered = url.to_ascii_lowercase();
    if !lowered.contains("youtube.com")
        && !lowered.contains("youtu.be")
        && !lowered.contains("youtube-nocookie.com")
    {
        return None;
    }
    // watch?v=ID (any query position)
    if let Some(idx) = url.find("v=") {
        let id: String = url[idx + 2..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if is_id(&id) {
            return Some(id);
        }
    }
    // youtu.be/ID, /shorts/ID, /embed/ID, /live/ID
    for marker in ["youtu.be/", "/shorts/", "/embed/", "/live/"] {
        if let Some(idx) = url.find(marker) {
            let id: String = url[idx + marker.len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if is_id(&id) {
                return Some(id);
            }
        }
    }
    None
}

pub fn watch_url(video_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={video_id}")
}

#[derive(Debug, Deserialize)]
pub struct OEmbed {
    pub title: String,
    pub author_name: String,
}

/// Title/channel for a single video via oEmbed — no API key required.
pub async fn oembed(client: &reqwest::Client, video_id: &str) -> Result<OEmbed, String> {
    let url = format!(
        "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{video_id}&format=json"
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("oEmbed request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "YouTube did not recognize this video (HTTP {})",
            resp.status()
        ));
    }
    resp.json::<OEmbed>()
        .await
        .map_err(|e| format!("oEmbed parse failed: {e}"))
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub video_id: String,
    pub title: String,
    pub channel: String,
    pub duration_ms: Option<u64>,
    /// Human "published" string, e.g. "9 years ago" (keyless) — for display.
    pub published: Option<String>,
}

/// Result ordering shared by the keyed and keyless search paths.
#[derive(Debug, Clone, Copy)]
pub enum SortOrder {
    Relevance,
    Date,
    Views,
    Rating,
}

impl SortOrder {
    pub fn parse(s: Option<&str>) -> SortOrder {
        match s.unwrap_or("relevance") {
            "date" => SortOrder::Date,
            "views" => SortOrder::Views,
            "rating" => SortOrder::Rating,
            _ => SortOrder::Relevance,
        }
    }
    /// Data API v3 `order` value.
    fn api_order(self) -> &'static str {
        match self {
            SortOrder::Relevance => "relevance",
            SortOrder::Date => "date",
            SortOrder::Views => "viewCount",
            SortOrder::Rating => "rating",
        }
    }
    /// Innertube `params` sort token (empty = relevance/default).
    fn innertube_params(self) -> &'static str {
        match self {
            SortOrder::Relevance => "",
            SortOrder::Date => "CAISAhAB",
            SortOrder::Views => "CAMSAhAB",
            SortOrder::Rating => "CAESAhAB",
        }
    }
}

/// Search YouTube (Data API v3, user's key) and fetch candidate durations.
pub async fn search(
    client: &reqwest::Client,
    api_key: &str,
    query: &str,
    max_results: u32,
    sort: SortOrder,
) -> Result<Vec<Candidate>, String> {
    #[derive(Deserialize)]
    struct SearchResp {
        items: Vec<SearchItem>,
        error: Option<serde_json::Value>,
    }
    #[derive(Deserialize)]
    struct SearchItem {
        id: SearchId,
        snippet: Snippet,
    }
    #[derive(Deserialize)]
    struct SearchId {
        #[serde(rename = "videoId")]
        video_id: Option<String>,
    }
    #[derive(Deserialize)]
    struct Snippet {
        title: String,
        #[serde(rename = "channelTitle")]
        channel_title: String,
        #[serde(rename = "publishedAt")]
        published_at: Option<String>,
    }

    let resp = client
        .get("https://www.googleapis.com/youtube/v3/search")
        .query(&[
            ("part", "snippet"),
            ("type", "video"),
            ("order", sort.api_order()),
            ("q", query),
            ("maxResults", &max_results.to_string()),
            ("key", api_key),
        ])
        .send()
        .await
        .map_err(|e| format!("YouTube search failed: {e}"))?;
    let status = resp.status();
    let body: SearchResp = resp
        .json()
        .await
        .map_err(|e| format!("YouTube search parse failed (HTTP {status}): {e}"))?;
    if let Some(err) = body.error {
        return Err(format!("YouTube API error: {err}"));
    }

    let mut candidates: Vec<Candidate> = body
        .items
        .into_iter()
        .filter_map(|i| {
            i.id.video_id.map(|video_id| Candidate {
                video_id,
                title: i.snippet.title,
                channel: i.snippet.channel_title,
                duration_ms: None,
                published: i.snippet.published_at,
            })
        })
        .collect();

    if candidates.is_empty() {
        return Ok(candidates);
    }

    // One videos.list call fills in durations for all candidates.
    #[derive(Deserialize)]
    struct VideosResp {
        items: Vec<VideoItem>,
    }
    #[derive(Deserialize)]
    struct VideoItem {
        id: String,
        #[serde(rename = "contentDetails")]
        content_details: ContentDetails,
    }
    #[derive(Deserialize)]
    struct ContentDetails {
        duration: String,
    }

    let ids: Vec<&str> = candidates.iter().map(|c| c.video_id.as_str()).collect();
    let videos = client
        .get("https://www.googleapis.com/youtube/v3/videos")
        .query(&[
            ("part", "contentDetails"),
            ("id", ids.join(",").as_str()),
            ("key", api_key),
        ])
        .send()
        .await
        .map_err(|e| format!("YouTube videos lookup failed: {e}"))?
        .json::<VideosResp>()
        .await
        .map_err(|e| format!("YouTube videos parse failed: {e}"))?;

    for item in videos.items {
        if let Some(c) = candidates.iter_mut().find(|c| c.video_id == item.id) {
            c.duration_ms = parse_iso8601_duration(&item.content_details.duration);
        }
    }
    Ok(candidates)
}

/// Keyless fallback search via YouTube's public web ("innertube") endpoint —
/// the same metadata the youtube.com search page loads. Used when no Data API
/// key is configured. Metadata only; playback is always the official embed.
pub async fn search_keyless(
    client: &reqwest::Client,
    query: &str,
    sort: SortOrder,
) -> Result<Vec<Candidate>, String> {
    // Public web-client key embedded in youtube.com pages (not a user secret).
    const WEB_KEY: &str = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
    let mut body = serde_json::json!({
        "context": {
            "client": { "clientName": "WEB", "clientVersion": "2.20240101.00.00" }
        },
        "query": query,
        // music category filter param is brittle; rely on scoring instead
    });
    let params = sort.innertube_params();
    if !params.is_empty() {
        body["params"] = serde_json::Value::String(params.to_string());
    }
    let resp = client
        .post(format!(
            "https://www.youtube.com/youtubei/v1/search?key={WEB_KEY}&prettyPrint=false"
        ))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("YouTube search failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("YouTube search failed (HTTP {})", resp.status()));
    }
    let value: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("YouTube search parse failed: {e}"))?;

    // Walk the response for videoRenderer objects, wherever they sit.
    let mut candidates = Vec::new();
    collect_video_renderers(&value, &mut candidates);
    candidates.truncate(8);
    Ok(candidates)
}

fn collect_video_renderers(value: &serde_json::Value, out: &mut Vec<Candidate>) {
    if out.len() >= 12 {
        return;
    }
    match value {
        serde_json::Value::Object(map) => {
            if let Some(vr) = map.get("videoRenderer") {
                if let Some(c) = video_renderer_to_candidate(vr) {
                    out.push(c);
                }
            }
            for v in map.values() {
                collect_video_renderers(v, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                collect_video_renderers(v, out);
            }
        }
        _ => {}
    }
}

fn video_renderer_to_candidate(vr: &serde_json::Value) -> Option<Candidate> {
    let video_id = vr.get("videoId")?.as_str()?.to_string();
    let title = vr
        .pointer("/title/runs/0/text")
        .and_then(|v| v.as_str())?
        .to_string();
    let channel = vr
        .pointer("/ownerText/runs/0/text")
        .or_else(|| vr.pointer("/longBylineText/runs/0/text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // "3:14" or "1:02:03"
    let duration_ms = vr
        .pointer("/lengthText/simpleText")
        .and_then(|v| v.as_str())
        .and_then(parse_clock_duration);
    let published = vr
        .pointer("/publishedTimeText/simpleText")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(Candidate {
        video_id,
        title,
        channel,
        duration_ms,
        published,
    })
}

/// "3:14" / "1:02:03" → milliseconds.
pub fn parse_clock_duration(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut total: u64 = 0;
    for p in &parts {
        total = total * 60 + p.parse::<u64>().ok()?;
    }
    Some(total * 1000)
}

/// "PT3M14S" → milliseconds.
pub fn parse_iso8601_duration(s: &str) -> Option<u64> {
    let rest = s.strip_prefix("PT").or_else(|| s.strip_prefix("P"))?;
    let mut total_secs: u64 = 0;
    let mut num = String::new();
    for c in rest.chars() {
        if c.is_ascii_digit() {
            num.push(c);
        } else {
            let value: u64 = num.parse().ok()?;
            num.clear();
            total_secs += match c {
                'H' => value * 3600,
                'M' => value * 60,
                'S' => value,
                'D' => value * 86_400,
                _ => return None,
            };
        }
    }
    Some(total_secs * 1000)
}

fn normalize(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(|t| t.to_string())
        .collect()
}

/// Heuristic match score, 0..~1.6. The M5 AI subsystem will add LLM ranking
/// on top of this; per project rules the free heuristic always runs first.
pub fn match_score(
    artist: &str,
    title: &str,
    want_duration_ms: Option<u64>,
    candidate: &Candidate,
) -> f32 {
    let want_tokens: Vec<String> = normalize(&format!("{artist} {title}"));
    let cand_tokens = normalize(&candidate.title);
    if want_tokens.is_empty() || cand_tokens.is_empty() {
        return 0.0;
    }
    let overlap = want_tokens
        .iter()
        .filter(|t| cand_tokens.contains(t))
        .count() as f32
        / want_tokens.len() as f32;
    let mut score = overlap;

    let channel = candidate.channel.to_lowercase();
    let artist_lc = artist.to_lowercase();
    if channel.ends_with("- topic") || channel.contains("official") {
        score += 0.3;
    } else if !artist_lc.is_empty() && channel.contains(&artist_lc) {
        score += 0.25;
    }

    if let (Some(want), Some(got)) = (want_duration_ms, candidate.duration_ms) {
        let diff = want.abs_diff(got);
        if diff <= 3_000 {
            score += 0.4;
        } else if diff <= 10_000 {
            score += 0.2;
        } else if diff > 30_000 {
            score -= 0.5;
        }
    }

    // Penalize obvious mismatches unless the query asked for them.
    let want_join = want_tokens.join(" ");
    for red_flag in ["live", "cover", "remix", "reaction", "karaoke"] {
        if cand_tokens.contains(&red_flag.to_string()) && !want_join.contains(red_flag) {
            score -= 0.3;
        }
    }
    score
}

pub fn best_match<'a>(
    artist: &str,
    title: &str,
    want_duration_ms: Option<u64>,
    candidates: &'a [Candidate],
) -> Option<(&'a Candidate, f32)> {
    candidates
        .iter()
        .map(|c| (c, match_score(artist, title, want_duration_ms, c)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .filter(|(_, score)| *score >= 0.5)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_url_shapes() {
        for url in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?list=x&v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ?t=10",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        ] {
            assert_eq!(
                parse_video_id(url).as_deref(),
                Some("dQw4w9WgXcQ"),
                "failed on {url}"
            );
        }
        assert_eq!(parse_video_id("https://example.com/watch?v=dQw4w9WgXcQ"), None);
        assert_eq!(parse_video_id("not a url"), None);
    }

    #[test]
    fn parses_clock_durations() {
        assert_eq!(parse_clock_duration("3:14"), Some(194_000));
        assert_eq!(parse_clock_duration("1:02:03"), Some(3_723_000));
        assert_eq!(parse_clock_duration("x"), None);
    }

    #[test]
    fn parses_iso8601_durations() {
        assert_eq!(parse_iso8601_duration("PT3M14S"), Some(194_000));
        assert_eq!(parse_iso8601_duration("PT1H2M3S"), Some(3_723_000));
        assert_eq!(parse_iso8601_duration("PT45S"), Some(45_000));
        assert_eq!(parse_iso8601_duration("bogus"), None);
    }

    fn cand(title: &str, channel: &str, secs: u64) -> Candidate {
        Candidate {
            video_id: "x".into(),
            title: title.into(),
            channel: channel.into(),
            duration_ms: Some(secs * 1000),
            published: None,
        }
    }

    #[test]
    fn matcher_prefers_official_audio_with_right_duration() {
        let candidates = vec![
            cand("Kashmir (Live at Knebworth)", "SomeChannel", 540),
            cand("Kashmir (Remaster)", "Led Zeppelin - Topic", 508),
            cand("Kashmir cover by me", "bedroomguitar", 300),
        ];
        let (best, score) =
            best_match("Led Zeppelin", "Kashmir", Some(509_000), &candidates).expect("match");
        assert_eq!(best.title, "Kashmir (Remaster)");
        assert!(score > 1.0, "score {score}");
    }

    #[test]
    fn matcher_rejects_garbage() {
        let candidates = vec![cand("totally unrelated video", "randomness", 100)];
        assert!(best_match("Led Zeppelin", "Kashmir", Some(509_000), &candidates).is_none());
    }
}
