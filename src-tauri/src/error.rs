use serde::Serialize;

/// Unified error type for all commands and subsystems.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("audio error: {0}")]
    Audio(String),

    #[error("decode error: {0}")]
    Decode(String),

    #[error("track {0} not found")]
    TrackNotFound(i64),

    #[error("capability gate: this track is {capability}, only OWNED tracks can be loaded into the player")]
    NotOwned { capability: String },

    #[error("{0}")]
    Other(String),
}

// Tauri commands need serializable errors; the frontend gets the message string.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
