pub mod local;

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
