use serde::{Deserialize, Serialize};

/// The non-negotiable capability flag. Controls what the engine may do with a track.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Capability {
    /// Local files, line-in, ripped CDs, CC catalogs → decode, mix, record.
    #[serde(rename = "OWNED")]
    Owned,
    /// Internet radio, YouTube embeds → play inline only, no DSP/mixer/recording.
    #[serde(rename = "STREAM_PLAYABLE")]
    StreamPlayable,
    /// Won't embed → open externally / preview only.
    #[serde(rename = "LINK_ONLY")]
    LinkOnly,
}

impl Capability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Capability::Owned => "OWNED",
            Capability::StreamPlayable => "STREAM_PLAYABLE",
            Capability::LinkOnly => "LINK_ONLY",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "OWNED" => Some(Capability::Owned),
            "STREAM_PLAYABLE" => Some(Capability::StreamPlayable),
            "LINK_ONLY" => Some(Capability::LinkOnly),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub bpm: Option<f64>,
    pub musical_key: Option<String>,
    pub duration_ms: Option<i64>,
    pub uri: String,
    pub source_kind: String,
    pub capability: Capability,
    /// User-facing media tag: music | podcast | audiobook | movie | radio | tutorial.
    pub media_type: String,
    pub fingerprint: Option<String>,
    pub musicbrainz_id: Option<String>,
    pub art_path: Option<String>,
    pub rating: i64,
    pub play_count: i64,
    pub added_at: i64,
}

/// A freshly-scanned track, before it has a DB id.
#[derive(Debug, Clone)]
pub struct NewTrack {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub duration_ms: Option<i64>,
    pub uri: String,
    pub source_kind: String,
    pub capability: Capability,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistInfo {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
}

/// A proposed metadata fill from an enrichment source (MusicBrainz, AcoustID,
/// or LLM). `None` fields mean "no suggestion"; the orchestrator merges these
/// over the existing track and the UI shows them for review.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataSuggestion {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub art_url: Option<String>,
    pub musicbrainz_id: Option<String>,
    /// Which tier produced this ("musicbrainz", "acoustid", "llm").
    pub source: String,
    /// 0.0..=1.0 rough confidence, for ordering and display.
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub errors: Vec<String>,
}
