pub mod local;
pub mod mpx;
pub mod mpx_export;
pub mod musicbrainz;
pub mod musicpax_feed;
pub mod wikipedia;
pub mod radio;
pub mod spotify;
pub mod youtube;

/// What a pasted "Add URL / list" input turned out to be (MusicPax-style
/// url-detector: classify first, then route to the source module).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectedInput {
    YouTubeVideo(String),
    SpotifyPlaylist(String),
    TextList,
    Unknown,
}

pub fn detect(input: &str) -> DetectedInput {
    let trimmed = input.trim();
    if let Some(id) = youtube::parse_video_id(trimmed) {
        return DetectedInput::YouTubeVideo(id);
    }
    if let Some(id) = spotify::parse_playlist_id(trimmed) {
        return DetectedInput::SpotifyPlaylist(id);
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return DetectedInput::Unknown;
    }
    if !trimmed.is_empty() {
        return DetectedInput::TextList;
    }
    DetectedInput::Unknown
}

use crate::library::model::Capability;

/// Every content source (local files, radio, YouTube, line-in, …) implements
/// this trait. The core never hard-codes a specific source; later milestones
/// register additional adapters alongside `LocalFilesAdapter`.
pub trait SourceAdapter: Send + Sync {
    /// Stable identifier stored in `tracks.source_kind` ('local', 'radio', …).
    fn kind(&self) -> &'static str;

    /// Human-readable name for the UI.
    fn display_name(&self) -> &'static str;

    /// The capability stamped on tracks originating from this source.
    /// The audio engine enforces OWNED-only at load time regardless.
    fn capability(&self) -> Capability;

    /// Whether this source supports importing into the library.
    fn can_import(&self) -> bool;
}
