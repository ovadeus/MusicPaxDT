//! MusicPax public feed client — the live, dynamic list from musicpax.com.
//!
//! Read-only metadata (URLs only — we never download or re-host media). The
//! endpoint is public, unauthenticated and CORS-open; we still proxy it through
//! the Rust HTTP client so the webview never hits a cross-origin wall and so we
//! can surface 429/rate-limit cleanly. Paginated; the UI does infinite scroll.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::net::http;

const BASE: &str = "https://musicpax.com/api/public/feed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub id: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub year: Option<String>,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub stream_url: Option<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub cover_image: Option<String>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub date_added: Option<String>,
    #[serde(default)]
    pub play_count: Option<i64>,
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pagination {
    pub current_page: i64,
    pub page_size: i64,
    pub total_items: i64,
    pub total_pages: i64,
    pub has_next_page: bool,
    pub has_previous_page: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedPage {
    pub data: Vec<FeedItem>,
    pub pagination: Pagination,
}

/// Fetch one page of the feed. `limit` is clamped to the server max (100);
/// `category` is omitted when empty or "all".
pub async fn fetch(page: u32, limit: u32, category: Option<&str>) -> AppResult<FeedPage> {
    let page = page.max(1);
    let limit = limit.clamp(1, 100);
    let mut req = http()
        .get(BASE)
        .query(&[("page", page.to_string()), ("limit", limit.to_string())]);
    if let Some(c) = category.filter(|c| !c.trim().is_empty() && !c.eq_ignore_ascii_case("all")) {
        req = req.query(&[("category", c)]);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Other(format!("feed request failed: {e}")))?;

    if resp.status().as_u16() == 429 {
        let retry = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("a few");
        return Err(AppError::Other(format!(
            "MusicPax feed is rate-limited — retry after {retry}s"
        )));
    }
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "MusicPax feed returned {}",
            resp.status()
        )));
    }

    resp.json::<FeedPage>()
        .await
        .map_err(|e| AppError::Other(format!("could not parse the feed: {e}")))
}
