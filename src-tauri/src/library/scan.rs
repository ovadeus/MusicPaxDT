use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::prelude::{Accessor, AudioFile, TagExt};
use lofty::tag::Tag;
use rusqlite::Connection;
use walkdir::WalkDir;

use crate::error::AppResult;
use crate::library::db;
use crate::library::model::{ImportResult, NewTrack, Track};
use crate::sources::local::LocalFilesAdapter;
use crate::sources::SourceAdapter;

const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "wav", "ogg", "oga", "m4a", "aac", "mp4", "aif", "aiff",
];

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Read tags with lofty; fall back to the file name when tags are unreadable
/// so untagged files still import.
fn read_track(path: &Path) -> NewTrack {
    let adapter = LocalFilesAdapter;
    let fallback_title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());

    let mut track = NewTrack {
        title: fallback_title,
        artist: None,
        album: None,
        year: None,
        genre: None,
        duration_ms: None,
        uri: path.to_string_lossy().into_owned(),
        source_kind: adapter.kind().to_string(),
        capability: adapter.capability(),
    };

    if let Ok(tagged) = lofty::read_from_path(path) {
        track.duration_ms = Some(tagged.properties().duration().as_millis() as i64);
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(title) = tag.title() {
                if !title.trim().is_empty() {
                    track.title = Some(title.into_owned());
                }
            }
            track.artist = tag.artist().map(|s| s.into_owned());
            track.album = tag.album().map(|s| s.into_owned());
            track.genre = tag.genre().map(|s| s.into_owned());
            track.year = tag.year().map(|y| y as i64);
        }
    }

    track
}

/// Write a track's edited metadata back into the file's tags. Best-effort:
/// failures (read-only file, unsupported container) are logged, not fatal —
/// the library row is already updated regardless.
pub fn write_tags(track: &Track) {
    let path = Path::new(&track.uri);
    if let Err(e) = write_tags_inner(track, path) {
        eprintln!("could not write tags to {}: {e}", path.display());
    }
}

fn write_tags_inner(track: &Track, path: &Path) -> Result<(), String> {
    // Start from the existing primary tag so other fields survive; fall back
    // to a fresh tag of the file's native type.
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let mut tag = tagged
        .primary_tag()
        .cloned()
        .unwrap_or_else(|| Tag::new(tagged.primary_tag_type()));

    match &track.title {
        Some(v) => tag.set_title(v.clone()),
        None => {
            tag.remove_title();
        }
    }
    match &track.artist {
        Some(v) => tag.set_artist(v.clone()),
        None => {
            tag.remove_artist();
        }
    }
    match &track.album {
        Some(v) => tag.set_album(v.clone()),
        None => {
            tag.remove_album();
        }
    }
    match &track.genre {
        Some(v) => tag.set_genre(v.clone()),
        None => {
            tag.remove_genre();
        }
    }
    match track.year {
        Some(y) if y > 0 => tag.set_year(y as u32),
        _ => {
            tag.remove_year();
        }
    }

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// Recursively import every audio file under `root`. Dedupes by uri.
pub fn import_folder(conn: &Connection, root: &Path) -> AppResult<ImportResult> {
    let mut result = ImportResult {
        imported: 0,
        skipped: 0,
        errors: Vec::new(),
    };
    let added_at = now_unix();

    // Batch inserts in a transaction instead of one implicit (fsync-ed)
    // transaction per file — a large import is dramatically faster. Commit in
    // chunks so a process/power interruption loses at most the current chunk.
    // Per-file tag/insert errors are collected (not propagated), so on the normal
    // path the same files import as before; only a fatal DB error (e.g. disk
    // full) now aborts the whole import instead of leaving a partial one.
    const CHUNK: usize = 500;
    let mut tx = conn.unchecked_transaction()?;
    let mut in_chunk = 0usize;

    for entry in WalkDir::new(root).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                result.errors.push(e.to_string());
                continue;
            }
        };
        if !entry.file_type().is_file() || !is_audio_file(entry.path()) {
            continue;
        }
        let track = read_track(entry.path());
        match db::insert_track(&tx, &track, added_at) {
            Ok(true) => result.imported += 1,
            Ok(false) => result.skipped += 1,
            Err(e) => result
                .errors
                .push(format!("{}: {e}", entry.path().display())),
        }
        in_chunk += 1;
        if in_chunk >= CHUNK {
            tx.commit()?;
            tx = conn.unchecked_transaction()?;
            in_chunk = 0;
        }
    }
    tx.commit()?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::tag::{Tag, TagType};

    /// Minimal valid 16-bit mono PCM WAV (0.1 s of silence).
    fn write_test_wav(path: &Path) {
        let sample_rate: u32 = 44_100;
        let n_samples: u32 = sample_rate / 10;
        let data_len = n_samples * 2;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
        bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        bytes.resize(bytes.len() + data_len as usize, 0);
        std::fs::write(path, bytes).unwrap();
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("stack-scan-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        dir
    }

    #[test]
    fn import_scans_recursively_reads_tags_and_dedupes() {
        use lofty::prelude::TagExt;

        let dir = temp_dir("import");
        let tagged_path = dir.join("tagged.wav");
        write_test_wav(&tagged_path);
        write_test_wav(&dir.join("nested").join("deep.wav"));
        std::fs::write(dir.join("notes.txt"), "not audio").unwrap();

        // Stamp real tags with lofty so the read path is exercised end to end.
        let mut tag = Tag::new(TagType::RiffInfo);
        tag.set_title("Test Tone".to_string());
        tag.set_artist("STACK CI".to_string());
        tag.save_to_path(&tagged_path, lofty::config::WriteOptions::default())
            .unwrap();

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::library::db::open_in_memory_for_tests(&conn);

        let first = import_folder(&conn, &dir).unwrap();
        assert_eq!(first.imported, 2, "errors: {:?}", first.errors);
        assert_eq!(first.skipped, 0);

        let again = import_folder(&conn, &dir).unwrap();
        assert_eq!(again.imported, 0);
        assert_eq!(again.skipped, 2, "rescan must dedupe by uri");

        let tracks = crate::library::db::list_tracks(&conn, None, None, None, 10, 0).unwrap();
        assert_eq!(tracks.len(), 2);
        let tagged = tracks
            .iter()
            .find(|t| t.uri.ends_with("tagged.wav"))
            .unwrap();
        assert_eq!(tagged.title.as_deref(), Some("Test Tone"));
        assert_eq!(tagged.artist.as_deref(), Some("STACK CI"));
        assert_eq!(tagged.capability.as_str(), "OWNED");
        assert!(tagged.duration_ms.unwrap_or(0) > 0);

        let untagged = tracks
            .iter()
            .find(|t| t.uri.ends_with("deep.wav"))
            .unwrap();
        assert_eq!(
            untagged.title.as_deref(),
            Some("deep"),
            "untagged files fall back to file name"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
