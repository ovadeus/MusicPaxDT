use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::{AppError, AppResult};
use crate::library::model::{Capability, NewTrack, Track};

const MIGRATION_0001: &str = r#"
CREATE TABLE tracks(
    id INTEGER PRIMARY KEY,
    title TEXT, artist TEXT, album TEXT, year INTEGER, genre TEXT,
    bpm REAL, musical_key TEXT, duration_ms INTEGER,
    uri TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    capability TEXT NOT NULL,
    fingerprint TEXT, musicbrainz_id TEXT, art_path TEXT,
    rating INTEGER DEFAULT 0, play_count INTEGER DEFAULT 0,
    added_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_tracks_uri ON tracks(uri);

CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title, artist, album, genre,
    content='tracks', content_rowid='id'
);
CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
    INSERT INTO tracks_fts(rowid, title, artist, album, genre)
    VALUES (new.id, new.title, new.artist, new.album, new.genre);
END;
CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre)
    VALUES ('delete', old.id, old.title, old.artist, old.album, old.genre);
END;
CREATE TRIGGER tracks_au AFTER UPDATE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre)
    VALUES ('delete', old.id, old.title, old.artist, old.album, old.genre);
    INSERT INTO tracks_fts(rowid, title, artist, album, genre)
    VALUES (new.id, new.title, new.artist, new.album, new.genre);
END;

CREATE TABLE playlists(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL);
CREATE TABLE playlist_items(playlist_id INTEGER, track_id INTEGER, position INTEGER);
CREATE TABLE crates(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE crate_items(crate_id INTEGER, track_id INTEGER);
CREATE TABLE smart_rules(playlist_id INTEGER, json_query TEXT);
CREATE TABLE history(track_id INTEGER, played_at INTEGER, deck TEXT);
CREATE TABLE cues(track_id INTEGER, position_ms INTEGER, label TEXT, color TEXT);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
"#;

/// Open (creating if needed) the library database and run pending migrations.
pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    // Each step and its user_version bump commit together. PRAGMA user_version is
    // transactional in SQLite, so a crash mid-migration rolls the whole step back
    // instead of leaving a half-applied schema that permanently bricks open().
    if version < 1 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATION_0001)?;
        tx.pragma_update(None, "user_version", 1)?;
        tx.commit()?;
    }
    if version < 2 {
        // Media type tag: Music / Podcast / Audiobook / Movie / Radio / Tutorial.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "ALTER TABLE tracks ADD COLUMN media_type TEXT NOT NULL DEFAULT 'music';",
        )?;
        tx.pragma_update(None, "user_version", 2)?;
        tx.commit()?;
    }
    if version < 3 {
        // Backfill the unambiguous case: radio stations imported before media
        // types existed are still tagged the 'music' default. Tag them Radio so
        // the type filter chips work. (Other sources can't be inferred.)
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "UPDATE tracks SET media_type = 'radio'
             WHERE source_kind = 'radio' AND media_type = 'music';",
        )?;
        tx.pragma_update(None, "user_version", 3)?;
        tx.commit()?;
    }
    if version < 4 {
        // User-orderable playlists (drag to reorder). Seed positions from the
        // existing id order so the sidebar looks unchanged until reordered.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "ALTER TABLE playlists ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
             UPDATE playlists SET position = id;",
        )?;
        tx.pragma_update(None, "user_version", 4)?;
        tx.commit()?;
    }
    if version < 5 {
        // Playlist folders: single-level grouping for the sidebar. A playlist's
        // folder_id is NULL for ungrouped ("root") playlists; deleting a folder
        // moves its playlists back to root, never deletes them.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE playlist_folders(
                 id INTEGER PRIMARY KEY,
                 name TEXT NOT NULL,
                 position INTEGER NOT NULL DEFAULT 0,
                 collapsed INTEGER NOT NULL DEFAULT 0
             );
             ALTER TABLE playlists ADD COLUMN folder_id INTEGER;",
        )?;
        tx.pragma_update(None, "user_version", 5)?;
        tx.commit()?;
    }
    if version < 6 {
        // Index the id-reference junction tables. `tracks` holds each track once
        // (unique on uri); playlists / crates / history / cues reference it by
        // track_id. Loading a playlist (WHERE playlist_id = ?) and deleting a
        // track (cascade WHERE track_id = ?) were full table scans without these.
        // Additive and behavior-preserving — just keeps lookups O(log n) as
        // libraries, playlists, and history grow large.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist ON playlist_items(playlist_id);
             CREATE INDEX IF NOT EXISTS idx_playlist_items_track    ON playlist_items(track_id);
             CREATE INDEX IF NOT EXISTS idx_crate_items_crate       ON crate_items(crate_id);
             CREATE INDEX IF NOT EXISTS idx_crate_items_track       ON crate_items(track_id);
             CREATE INDEX IF NOT EXISTS idx_cues_track              ON cues(track_id);
             CREATE INDEX IF NOT EXISTS idx_history_track           ON history(track_id);",
        )?;
        tx.pragma_update(None, "user_version", 6)?;
        tx.commit()?;
    }
    Ok(())
}

fn track_from_row(row: &Row) -> rusqlite::Result<Track> {
    let capability_str: String = row.get("capability")?;
    let capability = Capability::parse(&capability_str).unwrap_or(Capability::LinkOnly);
    Ok(Track {
        id: row.get("id")?,
        title: row.get("title")?,
        artist: row.get("artist")?,
        album: row.get("album")?,
        year: row.get("year")?,
        genre: row.get("genre")?,
        bpm: row.get("bpm")?,
        musical_key: row.get("musical_key")?,
        duration_ms: row.get("duration_ms")?,
        uri: row.get("uri")?,
        source_kind: row.get("source_kind")?,
        capability,
        media_type: row
            .get::<_, String>("media_type")
            .unwrap_or_else(|_| "music".to_string()),
        fingerprint: row.get("fingerprint")?,
        musicbrainz_id: row.get("musicbrainz_id")?,
        art_path: row.get("art_path")?,
        rating: row.get("rating")?,
        play_count: row.get("play_count")?,
        added_at: row.get("added_at")?,
    })
}

/// Insert a track; returns false (skipped) when a track with the same uri exists.
pub fn insert_track(conn: &Connection, t: &NewTrack, added_at: i64) -> AppResult<bool> {
    // Derive an initial media type from the source where it's unambiguous
    // (a radio station is Radio); everything else starts as Music and can be
    // re-tagged from the edit dialog. Keeps the type filter chips meaningful.
    let media_type = media_type_for_source(&t.source_kind);
    let changed = conn.execute(
        "INSERT OR IGNORE INTO tracks
            (title, artist, album, year, genre, duration_ms, uri, source_kind, capability, media_type, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            t.title,
            t.artist,
            t.album,
            t.year,
            t.genre,
            t.duration_ms,
            t.uri,
            t.source_kind,
            t.capability.as_str(),
            media_type,
            added_at
        ],
    )?;
    Ok(changed > 0)
}

/// Default media type implied by a track's source. Only `radio` is certain;
/// all other sources start as `music` (the user re-tags from the edit dialog).
pub fn media_type_for_source(source_kind: &str) -> &'static str {
    match source_kind {
        "radio" => "radio",
        _ => "music",
    }
}

pub fn get_track(conn: &Connection, id: i64) -> AppResult<Track> {
    conn.query_row("SELECT * FROM tracks WHERE id = ?1", [id], track_from_row)
        .optional()?
        .ok_or(AppError::TrackNotFound(id))
}

/// User-editable metadata fields. Empty strings are stored as NULL. The FTS5
/// triggers keep the search index in sync automatically.
#[derive(Debug, Clone, Default)]
pub struct TrackEdit {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    /// media_type override; None leaves the current value untouched (NOT NULL).
    pub media_type: Option<String>,
    /// Source URI override (e.g. swapping a STREAM_PLAYABLE YouTube video).
    /// None leaves the current value untouched (NOT NULL); the caller is
    /// responsible for validating/normalizing before it reaches here.
    pub uri: Option<String>,
}

pub fn update_track_metadata(conn: &Connection, id: i64, edit: &TrackEdit) -> AppResult<Track> {
    let blank_to_null = |s: &Option<String>| -> Option<String> {
        s.as_ref().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
    };
    let media_type = edit
        .media_type
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let changed = conn.execute(
        "UPDATE tracks SET title = ?1, artist = ?2, album = ?3, year = ?4, genre = ?5,
            media_type = COALESCE(?6, media_type), uri = COALESCE(?7, uri) WHERE id = ?8",
        params![
            blank_to_null(&edit.title),
            blank_to_null(&edit.artist),
            blank_to_null(&edit.album),
            edit.year,
            blank_to_null(&edit.genre),
            media_type,
            edit.uri,
            id
        ],
    )?;
    if changed == 0 {
        return Err(AppError::TrackNotFound(id));
    }
    get_track(conn, id)
}

const SORTABLE: &[(&str, &str)] = &[
    ("title", "title COLLATE NOCASE"),
    ("artist", "artist COLLATE NOCASE"),
    ("album", "album COLLATE NOCASE"),
    ("genre", "genre COLLATE NOCASE"),
    ("year", "year"),
    ("duration_ms", "duration_ms"),
    ("play_count", "play_count"),
    ("added_at", "added_at"),
];

/// Translate a "field:dir" sort spec into a safe ORDER BY clause (whitelisted).
fn order_by(sort: Option<&str>) -> String {
    let (field, dir) = match sort {
        Some(s) => {
            let mut parts = s.splitn(2, ':');
            (
                parts.next().unwrap_or("added_at"),
                if parts.next() == Some("desc") { "DESC" } else { "ASC" },
            )
        }
        None => ("added_at", "DESC"),
    };
    let column = SORTABLE
        .iter()
        .find(|(name, _)| *name == field)
        .map(|(_, col)| *col)
        .unwrap_or("added_at");
    format!("{column} {dir}")
}

/// Turn free text into an FTS5 prefix-match expression, quoting tokens so user
/// input can never inject FTS query syntax.
fn fts_expr(query: &str) -> String {
    query
        .split_whitespace()
        .map(|tok| format!("\"{}\"*", tok.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn list_tracks(
    conn: &Connection,
    query: Option<&str>,
    sort: Option<&str>,
    media_type: Option<&str>,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<Track>> {
    let order = order_by(sort);
    let q = query.map(str::trim).filter(|q| !q.is_empty());
    let m = media_type
        .map(str::trim)
        .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("all"));
    let mut tracks = Vec::new();
    let mut collect = |stmt: &mut rusqlite::Statement, p: &[&dyn rusqlite::ToSql]| -> AppResult<()> {
        let rows = stmt.query_map(p, track_from_row)?;
        for row in rows {
            tracks.push(row?);
        }
        Ok(())
    };
    match (q, m) {
        (Some(q), Some(m)) => {
            let sql = format!(
                "SELECT * FROM tracks
                 WHERE id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?1)
                   AND media_type = ?2 ORDER BY {order} LIMIT ?3 OFFSET ?4"
            );
            let mut stmt = conn.prepare(&sql)?;
            collect(&mut stmt, params![fts_expr(q), m, limit, offset])?;
        }
        (Some(q), None) => {
            let sql = format!(
                "SELECT * FROM tracks
                 WHERE id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?1)
                 ORDER BY {order} LIMIT ?2 OFFSET ?3"
            );
            let mut stmt = conn.prepare(&sql)?;
            collect(&mut stmt, params![fts_expr(q), limit, offset])?;
        }
        (None, Some(m)) => {
            let sql = format!(
                "SELECT * FROM tracks WHERE media_type = ?1 ORDER BY {order} LIMIT ?2 OFFSET ?3"
            );
            let mut stmt = conn.prepare(&sql)?;
            collect(&mut stmt, params![m, limit, offset])?;
        }
        (None, None) => {
            let sql = format!("SELECT * FROM tracks ORDER BY {order} LIMIT ?1 OFFSET ?2");
            let mut stmt = conn.prepare(&sql)?;
            collect(&mut stmt, params![limit, offset])?;
        }
    }
    Ok(tracks)
}

/// OWNED tracks whose file lives under `dir` (recursively) — the Live Media
/// list. Only files on this machine can go on air, so this is exactly the set
/// Go Live may play. Prefix-matched with substr rather than LIKE so a folder
/// named e.g. `My_Music` or `100%` can't act as a wildcard.
pub fn list_tracks_under(conn: &Connection, dir: &str) -> AppResult<Vec<Track>> {
    let prefix = format!("{}/", dir.trim_end_matches('/'));
    let mut stmt = conn.prepare(
        "SELECT * FROM tracks
         WHERE capability = 'OWNED' AND substr(uri, 1, length(?1)) = ?1
         ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, title COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![prefix], track_from_row)?;
    let mut tracks = Vec::new();
    for row in rows {
        tracks.push(row?);
    }
    Ok(tracks)
}

/// Run migrations on an arbitrary connection (used by tests in other modules).
#[cfg(test)]
pub fn open_in_memory_for_tests(conn: &Connection) {
    migrate(conn).expect("test migration failed");
}

pub fn get_all_settings(conn: &Connection) -> AppResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut settings = Vec::new();
    for row in rows {
        settings.push(row?);
    }
    Ok(settings)
}

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings(key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

/// Remove a track from the library: the row (FTS stays in sync via triggers),
/// plus its playlist/cue/history references. Does NOT touch the audio file on
/// disk — only the library entry.
pub fn delete_track(conn: &Connection, id: i64) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM playlist_items WHERE track_id = ?1", [id])?;
    tx.execute("DELETE FROM crate_items WHERE track_id = ?1", [id])?;
    tx.execute("DELETE FROM cues WHERE track_id = ?1", [id])?;
    tx.execute("DELETE FROM history WHERE track_id = ?1", [id])?;
    let n = tx.execute("DELETE FROM tracks WHERE id = ?1", [id])?;
    if n == 0 {
        // tx drops → the reference cleanup rolls back too.
        return Err(AppError::TrackNotFound(id));
    }
    tx.commit()?;
    Ok(())
}

/// Remove several tracks in one transaction (reuses the per-id reference
/// cleanup). Missing ids are skipped rather than aborting the batch. Returns
/// the number of track rows actually deleted. Audio files are left untouched.
pub fn delete_tracks(conn: &Connection, ids: &[i64]) -> AppResult<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut deleted = 0usize;
    for &id in ids {
        tx.execute("DELETE FROM playlist_items WHERE track_id = ?1", [id])?;
        tx.execute("DELETE FROM crate_items WHERE track_id = ?1", [id])?;
        tx.execute("DELETE FROM cues WHERE track_id = ?1", [id])?;
        tx.execute("DELETE FROM history WHERE track_id = ?1", [id])?;
        deleted += tx.execute("DELETE FROM tracks WHERE id = ?1", [id])?;
    }
    tx.commit()?;
    Ok(deleted)
}

pub fn set_track_musicbrainz_id(conn: &Connection, id: i64, mbid: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE tracks SET musicbrainz_id = ?1 WHERE id = ?2",
        params![mbid, id],
    )?;
    Ok(())
}

pub fn set_track_art_path(conn: &Connection, id: i64, art_path: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE tracks SET art_path = ?1 WHERE id = ?2",
        params![art_path, id],
    )?;
    Ok(())
}

/// Drop a cached cover so consumers fall back to deriving art from the uri
/// (e.g. after swapping a YouTube video, whose thumbnail comes from the id).
pub fn clear_track_art_path(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("UPDATE tracks SET art_path = NULL WHERE id = ?1", [id])?;
    Ok(())
}

/// Favorite / unfavorite a track. Favorites are stored as rating >= 1 so no
/// schema change is needed; "My Favorites" filters on it.
pub fn set_track_favorite(conn: &Connection, id: i64, favorite: bool) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE tracks SET rating = ?1 WHERE id = ?2",
        params![i64::from(favorite), id],
    )?;
    if changed == 0 {
        return Err(AppError::TrackNotFound(id));
    }
    Ok(())
}

/// (id, uri) for every local-file track — used to flag files that have moved.
pub fn local_track_uris(conn: &Connection) -> AppResult<Vec<(i64, String)>> {
    let mut stmt = conn.prepare("SELECT id, uri FROM tracks WHERE source_kind = 'local'")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Repoint a track to a new file path (relink a moved local file).
pub fn set_track_uri(conn: &Connection, id: i64, uri: &str) -> AppResult<Track> {
    conn.execute("UPDATE tracks SET uri = ?1 WHERE id = ?2", params![uri, id])?;
    get_track(conn, id)
}

pub fn get_track_by_uri(conn: &Connection, uri: &str) -> AppResult<Option<Track>> {
    Ok(conn
        .query_row("SELECT * FROM tracks WHERE uri = ?1", [uri], track_from_row)
        .optional()?)
}

/// Every track from a given source (e.g. "youtube") — used by the stream
/// health-check / self-heal pass.
pub fn tracks_by_source_kind(conn: &Connection, kind: &str) -> AppResult<Vec<Track>> {
    let mut stmt = conn.prepare("SELECT * FROM tracks WHERE source_kind = ?1")?;
    let rows = stmt.query_map([kind], track_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Playlists: the "building" layer — local OWNED files and STREAM_PLAYABLE
// entries live side by side in the same list.
// ---------------------------------------------------------------------------

pub fn create_playlist(conn: &Connection, name: &str) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO playlists(name, type, position)
         VALUES (?1, 'manual', (SELECT COALESCE(MAX(position), -1) + 1 FROM playlists))",
        [name],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Persist a new playlist order (the id list in display order → positions).
pub fn reorder_playlists(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE playlists SET position = ?1 WHERE id = ?2",
            params![i as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn list_playlists(conn: &Connection) -> AppResult<Vec<crate::library::model::PlaylistInfo>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, COUNT(pi.track_id), p.folder_id
         FROM playlists p
         LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
         GROUP BY p.id, p.name, p.position, p.folder_id
         ORDER BY p.position, p.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(crate::library::model::PlaylistInfo {
            id: r.get(0)?,
            name: r.get(1)?,
            track_count: r.get(2)?,
            folder_id: r.get(3)?,
        })
    })?;
    let mut playlists = Vec::new();
    for row in rows {
        playlists.push(row?);
    }
    Ok(playlists)
}

// ---------------------------------------------------------------------------
// Playlist folders: single-level sidebar grouping. Deleting a folder ungroups
// its playlists (folder_id → NULL) — playlists are never deleted with it.
// ---------------------------------------------------------------------------

pub fn list_folders(conn: &Connection) -> AppResult<Vec<crate::library::model::FolderInfo>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, position, collapsed FROM playlist_folders
         ORDER BY position, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(crate::library::model::FolderInfo {
            id: r.get(0)?,
            name: r.get(1)?,
            position: r.get(2)?,
            collapsed: r.get::<_, i64>(3)? != 0,
        })
    })?;
    let mut folders = Vec::new();
    for row in rows {
        folders.push(row?);
    }
    Ok(folders)
}

pub fn create_folder(conn: &Connection, name: &str) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO playlist_folders(name, position)
         VALUES (?1, (SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_folders))",
        [name.trim()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_folder(conn: &Connection, folder_id: i64, name: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE playlist_folders SET name = ?2 WHERE id = ?1",
        params![folder_id, name.trim()],
    )?;
    Ok(())
}

pub fn delete_folder(conn: &Connection, folder_id: i64) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE playlists SET folder_id = NULL WHERE folder_id = ?1",
        [folder_id],
    )?;
    tx.execute("DELETE FROM playlist_folders WHERE id = ?1", [folder_id])?;
    tx.commit()?;
    Ok(())
}

pub fn set_folder_collapsed(conn: &Connection, folder_id: i64, collapsed: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE playlist_folders SET collapsed = ?2 WHERE id = ?1",
        params![folder_id, collapsed as i64],
    )?;
    Ok(())
}

/// Move a playlist into a folder (or out, with None). Validates the folder
/// exists so a stale id can't strand the playlist in an invisible group.
pub fn move_playlist_to_folder(
    conn: &Connection,
    playlist_id: i64,
    folder_id: Option<i64>,
) -> AppResult<()> {
    if let Some(fid) = folder_id {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM playlist_folders WHERE id = ?1",
            [fid],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::Other("folder not found".into()));
        }
    }
    conn.execute(
        "UPDATE playlists SET folder_id = ?2 WHERE id = ?1",
        params![playlist_id, folder_id],
    )?;
    Ok(())
}

/// Persist a new folder order (the id list in display order → positions).
pub fn reorder_folders(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE playlist_folders SET position = ?1 WHERE id = ?2",
            params![i as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn playlist_tracks(conn: &Connection, playlist_id: i64) -> AppResult<Vec<Track>> {
    let mut stmt = conn.prepare(
        "SELECT t.* FROM tracks t
         JOIN playlist_items pi ON pi.track_id = t.id
         WHERE pi.playlist_id = ?1
         ORDER BY pi.position",
    )?;
    let rows = stmt.query_map([playlist_id], track_from_row)?;
    let mut tracks = Vec::new();
    for row in rows {
        tracks.push(row?);
    }
    Ok(tracks)
}

pub fn add_to_playlist(conn: &Connection, playlist_id: i64, track_id: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO playlist_items(playlist_id, track_id, position)
         SELECT ?1, ?2, COALESCE(MAX(position), 0) + 1
         FROM playlist_items WHERE playlist_id = ?1",
        params![playlist_id, track_id],
    )?;
    Ok(())
}

/// Append many tracks to a playlist in one transaction, preserving the given
/// order and skipping tracks already in the playlist (so a repeated "add
/// selected" can't create duplicate rows). Returns how many were newly added.
pub fn add_tracks_to_playlist(
    conn: &Connection,
    playlist_id: i64,
    track_ids: &[i64],
) -> AppResult<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut existing: std::collections::HashSet<i64> = {
        let mut stmt =
            tx.prepare("SELECT track_id FROM playlist_items WHERE playlist_id = ?1")?;
        let rows = stmt.query_map([playlist_id], |r| r.get::<_, i64>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut position: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position), 0) FROM playlist_items WHERE playlist_id = ?1",
        [playlist_id],
        |r| r.get(0),
    )?;
    let mut added = 0usize;
    for &track_id in track_ids {
        // Skip duplicates, both against existing rows and within this batch.
        if !existing.insert(track_id) {
            continue;
        }
        position += 1;
        tx.execute(
            "INSERT INTO playlist_items(playlist_id, track_id, position)
             VALUES (?1, ?2, ?3)",
            params![playlist_id, track_id, position],
        )?;
        added += 1;
    }
    tx.commit()?;
    Ok(added)
}

pub fn delete_playlist(conn: &Connection, playlist_id: i64) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM playlist_items WHERE playlist_id = ?1", [playlist_id])?;
    tx.execute("DELETE FROM playlists WHERE id = ?1", [playlist_id])?;
    tx.commit()?;
    Ok(())
}

pub fn rename_playlist(conn: &Connection, playlist_id: i64, name: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE playlists SET name = ?2 WHERE id = ?1",
        params![playlist_id, name.trim()],
    )?;
    Ok(())
}

/// Record a successful load: bump play_count and append to history.
pub fn record_play(conn: &Connection, track_id: i64, played_at: i64) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE tracks SET play_count = play_count + 1 WHERE id = ?1",
        [track_id],
    )?;
    tx.execute(
        "INSERT INTO history(track_id, played_at, deck) VALUES (?1, ?2, 'main')",
        params![track_id, played_at],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn new_track(title: &str, artist: &str, uri: &str) -> NewTrack {
        NewTrack {
            title: Some(title.into()),
            artist: Some(artist.into()),
            album: None,
            year: Some(1971),
            genre: Some("Rock".into()),
            duration_ms: Some(482_000),
            uri: uri.into(),
            source_kind: "local".into(),
            capability: Capability::Owned,
        }
    }

    /// The Live Media list is exactly the OWNED files under the chosen folder:
    /// a sibling folder sharing the prefix (`Music2` vs `Music`) must not leak
    /// in, LIKE wildcards in the folder name must not widen the match, and a
    /// stream living "under" the path can never appear — streams can't air.
    #[test]
    fn list_tracks_under_is_an_exact_folder_prefix_of_owned_files() {
        let conn = mem_db();
        let dir = "/Users/me/My_Music 100%";
        insert_track(&conn, &new_track("In", "A", &format!("{dir}/a.mp3")), 0).unwrap();
        insert_track(&conn, &new_track("Deep", "A", &format!("{dir}/sub/b.mp3")), 0).unwrap();
        // Sibling folder that merely starts with the same text.
        insert_track(&conn, &new_track("Sibling", "A", &format!("{dir}2/c.mp3")), 0).unwrap();
        // `_` and `%` would match anything under LIKE; they must be literal here.
        insert_track(&conn, &new_track("Wild", "A", "/Users/me/MyXMusic 100Y/d.mp3"), 0).unwrap();
        let mut stream = new_track("Stream", "A", &format!("{dir}/e"));
        stream.capability = Capability::StreamPlayable;
        insert_track(&conn, &stream, 0).unwrap();

        let got: Vec<String> = list_tracks_under(&conn, dir)
            .unwrap()
            .into_iter()
            .map(|t| t.title.unwrap())
            .collect();
        assert_eq!(got, vec!["Deep", "In"], "sorted by title; nothing else leaks in");

        // A trailing slash on the chosen folder is normalised away.
        assert_eq!(list_tracks_under(&conn, &format!("{dir}/")).unwrap().len(), 2);
    }

    #[test]
    fn migration_creates_schema_and_fts() {
        let conn = mem_db();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 6);
        // FTS5 table exists and is queryable
        let count: i64 = conn
            .query_row("SELECT count(*) FROM tracks_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn junction_tables_are_indexed() {
        // Reference-by-id junction tables must be indexed so playlist loads and
        // track-delete cascades stay fast at scale (millions of rows).
        let conn = mem_db();
        let names: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        for want in [
            "idx_playlist_items_playlist",
            "idx_playlist_items_track",
            "idx_crate_items_crate",
            "idx_crate_items_track",
            "idx_cues_track",
            "idx_history_track",
        ] {
            assert!(names.iter().any(|n| n == want), "missing index: {want}");
        }
    }

    #[test]
    fn delete_tracks_batch_removes_selected_and_skips_missing() {
        let conn = mem_db();
        insert_track(&conn, &new_track("A", "X", "u:a"), 0).unwrap();
        insert_track(&conn, &new_track("B", "X", "u:b"), 0).unwrap();
        insert_track(&conn, &new_track("C", "X", "u:c"), 0).unwrap();
        let id = |uri: &str| get_track_by_uri(&conn, uri).unwrap().unwrap().id;
        let (a, b, c) = (id("u:a"), id("u:b"), id("u:c"));

        // Put A and B in a playlist so we also exercise reference cleanup.
        let pl = create_playlist(&conn, "P").unwrap();
        add_to_playlist(&conn, pl, a).unwrap();
        add_to_playlist(&conn, pl, b).unwrap();

        // Delete A and B plus a bogus id (9999) — the bogus one is skipped, not
        // an error, and only 2 rows are reported deleted.
        let deleted = delete_tracks(&conn, &[a, b, 9999]).unwrap();
        assert_eq!(deleted, 2);

        let remaining: i64 = conn
            .query_row("SELECT count(*) FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 1);
        assert!(get_track_by_uri(&conn, "u:a").unwrap().is_none());
        assert!(get_track_by_uri(&conn, "u:c").unwrap().is_some());
        assert_eq!(c, id("u:c")); // untouched
        // Playlist references for the deleted tracks are gone.
        let pl_items: i64 = conn
            .query_row("SELECT count(*) FROM playlist_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pl_items, 0);
    }

    #[test]
    fn folders_group_rename_collapse_and_ungroup_on_delete() {
        let conn = mem_db();
        let p1 = create_playlist(&conn, "Rock").unwrap();
        let p2 = create_playlist(&conn, "Jazz").unwrap();

        let f = create_folder(&conn, "Genres").unwrap();
        move_playlist_to_folder(&conn, p1, Some(f)).unwrap();
        move_playlist_to_folder(&conn, p2, Some(f)).unwrap();
        // A bogus folder id must be rejected, not silently strand the playlist.
        assert!(move_playlist_to_folder(&conn, p1, Some(9999)).is_err());

        let playlists = list_playlists(&conn).unwrap();
        assert!(playlists.iter().all(|p| p.folder_id == Some(f)));

        rename_folder(&conn, f, "  Styles  ").unwrap();
        set_folder_collapsed(&conn, f, true).unwrap();
        let folders = list_folders(&conn).unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].name, "Styles"); // trimmed
        assert!(folders[0].collapsed);

        // Deleting the folder ungroups, never deletes, its playlists.
        delete_folder(&conn, f).unwrap();
        assert!(list_folders(&conn).unwrap().is_empty());
        let playlists = list_playlists(&conn).unwrap();
        assert_eq!(playlists.len(), 2);
        assert!(playlists.iter().all(|p| p.folder_id.is_none()));

        // Folder reorder persists positions.
        let f1 = create_folder(&conn, "A").unwrap();
        let f2 = create_folder(&conn, "B").unwrap();
        reorder_folders(&conn, &[f2, f1]).unwrap();
        let names: Vec<String> = list_folders(&conn).unwrap().into_iter().map(|x| x.name).collect();
        assert_eq!(names, ["B", "A"]);
    }

    #[test]
    fn insert_dedupes_by_uri() {
        let conn = mem_db();
        let t = new_track("Stairway to Heaven", "Led Zeppelin", "/music/stairway.flac");
        assert!(insert_track(&conn, &t, 1).unwrap());
        assert!(!insert_track(&conn, &t, 2).unwrap(), "same uri must be skipped");
        let all = list_tracks(&conn, None, None, None, 100, 0).unwrap();
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn fts_search_matches_and_filters() {
        let conn = mem_db();
        insert_track(
            &conn,
            &new_track("Stairway to Heaven", "Led Zeppelin", "/m/a.flac"),
            1,
        )
        .unwrap();
        insert_track(&conn, &new_track("Kashmir", "Led Zeppelin", "/m/b.flac"), 1).unwrap();
        insert_track(&conn, &new_track("Hey Jude", "The Beatles", "/m/c.mp3"), 1).unwrap();

        let zep = list_tracks(&conn, Some("zeppelin"), None, None, 100, 0).unwrap();
        assert_eq!(zep.len(), 2);
        // prefix search
        let stair = list_tracks(&conn, Some("stair"), None, None, 100, 0).unwrap();
        assert_eq!(stair.len(), 1);
        assert_eq!(stair[0].title.as_deref(), Some("Stairway to Heaven"));
        // FTS metacharacters must not inject syntax errors
        let weird = list_tracks(&conn, Some("\"AND( near:*"), None, None, 100, 0);
        assert!(weird.is_ok());
    }

    #[test]
    fn sort_is_whitelisted() {
        let conn = mem_db();
        insert_track(&conn, &new_track("B side", "X", "/m/1.mp3"), 1).unwrap();
        insert_track(&conn, &new_track("A side", "X", "/m/2.mp3"), 2).unwrap();
        let sorted = list_tracks(&conn, None, Some("title:asc"), None, 100, 0).unwrap();
        assert_eq!(sorted[0].title.as_deref(), Some("A side"));
        // unknown field falls back instead of injecting SQL
        let fallback = list_tracks(&conn, None, Some("evil; DROP TABLE tracks:asc"), None, 100, 0);
        assert!(fallback.is_ok());
    }

    #[test]
    fn playlists_mix_owned_and_stream_tracks() {
        let conn = mem_db();
        insert_track(&conn, &new_track("Kashmir", "Led Zeppelin", "/m/kashmir.flac"), 1).unwrap();
        let mut stream = new_track("Kashmir", "Led Zeppelin", "https://www.youtube.com/watch?v=abcdefghijk");
        stream.capability = Capability::StreamPlayable;
        stream.source_kind = "youtube".into();
        insert_track(&conn, &stream, 2).unwrap();

        let pid = create_playlist(&conn, "Mixed").unwrap();
        let all = list_tracks(&conn, None, Some("added_at:asc"), None, 10, 0).unwrap();
        add_to_playlist(&conn, pid, all[0].id).unwrap();
        add_to_playlist(&conn, pid, all[1].id).unwrap();

        let lists = list_playlists(&conn).unwrap();
        assert_eq!(lists.len(), 1);
        assert_eq!(lists[0].track_count, 2);

        let items = playlist_tracks(&conn, pid).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].capability, Capability::Owned);
        assert_eq!(items[1].capability, Capability::StreamPlayable);

        delete_playlist(&conn, pid).unwrap();
        assert!(list_playlists(&conn).unwrap().is_empty());
        // tracks survive playlist deletion
        assert_eq!(list_tracks(&conn, None, None, None, 10, 0).unwrap().len(), 2);
    }

    #[test]
    fn add_tracks_batch_preserves_order_and_skips_duplicates() {
        let conn = mem_db();
        for (i, name) in ["A", "B", "C"].iter().enumerate() {
            insert_track(&conn, &new_track(name, "Artist", &format!("/m/{name}.flac")), i as i64)
                .unwrap();
        }
        let ids: Vec<i64> = list_tracks(&conn, None, Some("added_at:asc"), None, 10, 0)
            .unwrap()
            .iter()
            .map(|t| t.id)
            .collect();
        let pid = create_playlist(&conn, "Batch").unwrap();

        // First add C then A, in that order.
        let added = add_tracks_to_playlist(&conn, pid, &[ids[2], ids[0]]).unwrap();
        assert_eq!(added, 2);

        // Re-add A (already present, in-batch dup of B) plus B twice → only B lands.
        let added = add_tracks_to_playlist(&conn, pid, &[ids[0], ids[1], ids[1]]).unwrap();
        assert_eq!(added, 1);

        let items = playlist_tracks(&conn, pid).unwrap();
        let order: Vec<&str> = items.iter().map(|t| t.title.as_deref().unwrap()).collect();
        assert_eq!(order, vec!["C", "A", "B"], "append order preserved, no dupes");
        assert_eq!(list_playlists(&conn).unwrap()[0].track_count, 3);
    }

    #[test]
    fn metadata_edit_updates_row_and_fts() {
        let conn = mem_db();
        insert_track(
            &conn,
            &new_track("Sade Greatest Hits Smooth Operator", "Midnight Cassette", "/m/x.mp3"),
            1,
        )
        .unwrap();
        let id = list_tracks(&conn, None, None, None, 10, 0).unwrap()[0].id;

        let edit = TrackEdit {
            title: Some("Smooth Operator".into()),
            artist: Some("Sade".into()),
            album: Some("Diamond Life".into()),
            year: Some(1984),
            genre: Some("  ".into()), // whitespace → NULL
            media_type: None,
            uri: None,
        };
        let updated = update_track_metadata(&conn, id, &edit).unwrap();
        assert_eq!(updated.title.as_deref(), Some("Smooth Operator"));
        assert_eq!(updated.artist.as_deref(), Some("Sade"));
        assert_eq!(updated.album.as_deref(), Some("Diamond Life"));
        assert_eq!(updated.year, Some(1984));
        assert_eq!(updated.genre, None, "blank genre stored as NULL");

        // FTS reflects the new title, not the old one.
        let hit = list_tracks(&conn, Some("smooth operator"), None, None, 10, 0).unwrap();
        assert_eq!(hit.len(), 1);
        let stale = list_tracks(&conn, Some("greatest"), None, None, 10, 0).unwrap();
        assert!(stale.is_empty(), "old title must leave the FTS index");

        // Unknown id is an error.
        assert!(update_track_metadata(&conn, 9999, &edit).is_err());
    }

    #[test]
    fn delete_track_removes_row_playlist_links_and_fts() {
        let conn = mem_db();
        insert_track(&conn, &new_track("Kashmir", "Led Zeppelin", "/m/k.flac"), 1).unwrap();
        let id = list_tracks(&conn, None, None, None, 10, 0).unwrap()[0].id;
        let pid = create_playlist(&conn, "P").unwrap();
        add_to_playlist(&conn, pid, id).unwrap();

        delete_track(&conn, id).unwrap();
        assert!(list_tracks(&conn, None, None, None, 10, 0).unwrap().is_empty());
        assert!(playlist_tracks(&conn, pid).unwrap().is_empty(), "playlist link removed");
        assert!(
            list_tracks(&conn, Some("kashmir"), None, None, 10, 0).unwrap().is_empty(),
            "FTS entry removed"
        );
        assert!(delete_track(&conn, id).is_err(), "second delete is an error");
    }

    #[test]
    fn capability_round_trips() {
        let conn = mem_db();
        let mut t = new_track("Radio Stream", "Station", "radio://example");
        t.capability = Capability::StreamPlayable;
        insert_track(&conn, &t, 1).unwrap();
        let all = list_tracks(&conn, None, None, None, 10, 0).unwrap();
        assert_eq!(all[0].capability, Capability::StreamPlayable);
    }

    #[test]
    fn radio_source_gets_radio_media_type_and_filters() {
        let conn = mem_db();
        let song = new_track("A Song", "An Artist", "/m/a.flac"); // source_kind = local
        insert_track(&conn, &song, 1).unwrap();
        let mut station = new_track("A Station", "Broadcaster", "https://stream.example/live");
        station.capability = Capability::StreamPlayable;
        station.source_kind = "radio".into();
        insert_track(&conn, &station, 2).unwrap();

        // Radio-source rows are tagged 'radio'; every other source stays 'music'.
        let radio = list_tracks(&conn, None, None, Some("radio"), 10, 0).unwrap();
        assert_eq!(radio.len(), 1);
        assert_eq!(radio[0].title.as_deref(), Some("A Station"));
        let music = list_tracks(&conn, None, None, Some("music"), 10, 0).unwrap();
        assert_eq!(music.len(), 1);
        assert_eq!(music[0].title.as_deref(), Some("A Song"));
    }
}
