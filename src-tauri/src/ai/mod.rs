//! Tier 3 enrichment: the LLM layer. Vendor-agnostic by design (CLAUDE.md):
//! Anthropic, OpenAI, and Ollama sit behind one dispatcher. The LLM is used
//! ONLY for cleaning messy strings (e.g. hideous YouTube titles) into a
//! structured {artist, title} query and for light genre inference — never as
//! the source of truth. Its output is fed back into the free MusicBrainz tier
//! for authoritative confirmation. Keys live in the OS keychain.

use serde::Deserialize;
use serde_json::json;

use crate::net::http;

/// Provider selection + credentials, resolved from settings + keychain.
#[derive(Debug, Clone)]
pub enum LlmProvider {
    Anthropic { api_key: String, model: String },
    OpenAi { api_key: String, model: String },
    /// Local Ollama — no key, no cost.
    Ollama { host: String, model: String },
}

/// Structured result of a cleanup call.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CleanedTags {
    pub artist: Option<String>,
    pub title: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
}

const SYSTEM: &str = "You normalize messy music track labels into clean metadata. \
Given a raw title (often a YouTube video title with extra junk: channel names, \
'[Official Video]', emojis, view counts, 'HD', track lists, etc.) and an optional \
raw artist, extract the single most likely song. Respond with ONLY a JSON object, \
no prose, of the form {\"artist\": string|null, \"title\": string|null, \"album\": \
string|null, \"genre\": string|null}. Use null when unsure. Do not invent an album \
or genre you are not confident about — those are better resolved elsewhere.";

fn build_prompt(raw_title: &str, raw_artist: Option<&str>) -> String {
    match raw_artist {
        Some(a) if !a.trim().is_empty() => {
            format!("Raw title: {raw_title}\nRaw artist: {a}")
        }
        _ => format!("Raw title: {raw_title}"),
    }
}

/// Extract the first JSON object from a model response (handles ```json fences
/// and leading prose defensively).
fn parse_json_object(text: &str) -> Result<CleanedTags, String> {
    let start = text.find('{').ok_or("no JSON object in LLM response")?;
    let end = text.rfind('}').ok_or("unterminated JSON in LLM response")?;
    if end < start {
        return Err("malformed JSON in LLM response".into());
    }
    serde_json::from_str(&text[start..=end]).map_err(|e| format!("LLM JSON parse failed: {e}"))
}

impl LlmProvider {
    pub fn label(&self) -> String {
        match self {
            LlmProvider::Anthropic { model, .. } => format!("Anthropic ({model})"),
            LlmProvider::OpenAi { model, .. } => format!("OpenAI ({model})"),
            LlmProvider::Ollama { model, .. } => format!("Ollama ({model})"),
        }
    }

    /// Rough USD cost for one cleanup call. Local Ollama is free; cloud uses a
    /// small fixed token budget (~600 in, ~120 out) against per-model pricing.
    pub fn estimate_cost_usd(&self) -> f64 {
        let (in_per_m, out_per_m) = match self {
            LlmProvider::Ollama { .. } => return 0.0,
            LlmProvider::Anthropic { model, .. } => anthropic_pricing(model),
            LlmProvider::OpenAi { model, .. } => openai_pricing(model),
        };
        let in_tok = 600.0;
        let out_tok = 120.0;
        in_tok / 1_000_000.0 * in_per_m + out_tok / 1_000_000.0 * out_per_m
    }

    pub async fn clean_metadata(
        &self,
        raw_title: &str,
        raw_artist: Option<&str>,
    ) -> Result<CleanedTags, String> {
        let prompt = build_prompt(raw_title, raw_artist);
        let text = match self {
            LlmProvider::Anthropic { api_key, model } => {
                anthropic_call(api_key, model, &prompt).await?
            }
            LlmProvider::OpenAi { api_key, model } => openai_call(api_key, model, &prompt).await?,
            LlmProvider::Ollama { host, model } => ollama_call(host, model, &prompt).await?,
        };
        parse_json_object(&text)
    }
}

// --- Anthropic Messages API ------------------------------------------------
// Per the claude-api reference: POST /v1/messages, x-api-key + anthropic-version
// headers. No `temperature`/`top_p`/`thinking` — those 400 on Opus 4.8 / Fable 5.
// Default model claude-opus-4-8; user-configurable.

fn anthropic_pricing(model: &str) -> (f64, f64) {
    // (input $/1M, output $/1M)
    if model.contains("haiku") {
        (1.0, 5.0)
    } else if model.contains("sonnet") {
        (3.0, 15.0)
    } else if model.contains("fable") {
        (10.0, 50.0)
    } else {
        (5.0, 25.0) // opus tier
    }
}

async fn anthropic_call(api_key: &str, model: &str, prompt: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Resp {
        content: Option<Vec<Block>>,
        error: Option<ApiError>,
    }
    #[derive(Deserialize)]
    struct Block {
        #[serde(rename = "type")]
        kind: String,
        text: Option<String>,
    }
    #[derive(Deserialize)]
    struct ApiError {
        message: String,
    }

    let body = json!({
        "model": model,
        "max_tokens": 512,
        "system": SYSTEM,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let resp = http()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {e}"))?;
    let parsed: Resp = resp
        .json()
        .await
        .map_err(|e| format!("Anthropic parse failed: {e}"))?;
    if let Some(err) = parsed.error {
        return Err(format!("Anthropic API error: {}", err.message));
    }
    parsed
        .content
        .unwrap_or_default()
        .into_iter()
        .find(|b| b.kind == "text")
        .and_then(|b| b.text)
        .ok_or_else(|| "Anthropic returned no text".into())
}

// --- OpenAI Chat Completions ----------------------------------------------

fn openai_pricing(model: &str) -> (f64, f64) {
    if model.contains("mini") {
        (0.15, 0.60)
    } else {
        (2.50, 10.0)
    }
}

async fn openai_call(api_key: &str, model: &str, prompt: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Resp {
        choices: Option<Vec<Choice>>,
        error: Option<ApiError>,
    }
    #[derive(Deserialize)]
    struct Choice {
        message: ChoiceMessage,
    }
    #[derive(Deserialize)]
    struct ChoiceMessage {
        content: Option<String>,
    }
    #[derive(Deserialize)]
    struct ApiError {
        message: String,
    }

    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM },
            { "role": "user", "content": prompt },
        ],
    });
    let resp = http()
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {e}"))?;
    let parsed: Resp = resp
        .json()
        .await
        .map_err(|e| format!("OpenAI parse failed: {e}"))?;
    if let Some(err) = parsed.error {
        return Err(format!("OpenAI API error: {}", err.message));
    }
    parsed
        .choices
        .unwrap_or_default()
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .ok_or_else(|| "OpenAI returned no content".into())
}

// --- Ollama (local) --------------------------------------------------------

async fn ollama_call(host: &str, model: &str, prompt: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Resp {
        response: Option<String>,
        error: Option<String>,
    }
    let host = host.trim_end_matches('/');
    let body = json!({
        "model": model,
        "system": SYSTEM,
        "prompt": prompt,
        "stream": false,
        "format": "json",
    });
    let resp = http()
        .post(format!("{host}/api/generate"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed (is it running?): {e}"))?;
    let parsed: Resp = resp
        .json()
        .await
        .map_err(|e| format!("Ollama parse failed: {e}"))?;
    if let Some(err) = parsed.error {
        return Err(format!("Ollama error: {err}"));
    }
    parsed.response.ok_or_else(|| "Ollama returned no response".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_json() {
        let t = parse_json_object(r#"{"artist":"Sade","title":"Smooth Operator","album":null,"genre":"Soul"}"#).unwrap();
        assert_eq!(t.artist.as_deref(), Some("Sade"));
        assert_eq!(t.title.as_deref(), Some("Smooth Operator"));
        assert_eq!(t.album, None);
        assert_eq!(t.genre.as_deref(), Some("Soul"));
    }

    #[test]
    fn parses_fenced_and_prosey_json() {
        let t = parse_json_object("Here you go:\n```json\n{\"artist\":\"Sade\",\"title\":\"Smooth Operator\"}\n```").unwrap();
        assert_eq!(t.artist.as_deref(), Some("Sade"));
        assert_eq!(t.title.as_deref(), Some("Smooth Operator"));
    }

    #[test]
    fn rejects_non_json() {
        assert!(parse_json_object("I cannot help with that").is_err());
    }

    #[test]
    fn cost_estimate_is_zero_for_ollama_and_positive_for_cloud() {
        let local = LlmProvider::Ollama {
            host: "http://localhost:11434".into(),
            model: "llama3".into(),
        };
        assert_eq!(local.estimate_cost_usd(), 0.0);
        let cloud = LlmProvider::Anthropic {
            api_key: "x".into(),
            model: "claude-opus-4-8".into(),
        };
        assert!(cloud.estimate_cost_usd() > 0.0);
        // Haiku must be cheaper than Opus.
        let haiku = LlmProvider::Anthropic {
            api_key: "x".into(),
            model: "claude-haiku-4-5".into(),
        };
        assert!(haiku.estimate_cost_usd() < cloud.estimate_cost_usd());
    }
}
