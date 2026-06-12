use crate::library::model::Capability;
use crate::sources::SourceAdapter;

/// Local audio files on disk. The only adapter implemented in Milestone 1.
pub struct LocalFilesAdapter;

impl SourceAdapter for LocalFilesAdapter {
    fn kind(&self) -> &'static str {
        "local"
    }

    fn display_name(&self) -> &'static str {
        "Local Files"
    }

    fn capability(&self) -> Capability {
        Capability::Owned
    }

    fn can_import(&self) -> bool {
        true
    }
}
