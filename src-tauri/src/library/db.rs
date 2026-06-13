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
    if version < 1 {
        conn.execute_batch(MIGRATION_0001)?;
        conn.pragma_update(None, "user_version", 1)?;
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
    let changed = conn.execute(
        "INSERT OR IGNORE INTO tracks
            (title, artist, album, year, genre, duration_ms, uri, source_kind, capability, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
            added_at
        ],
    )?;
    Ok(changed > 0)
}

pub fn get_track(conn: &Connection, id: i64) -> AppResult<Track> {
    conn.query_row("SELECT * FROM tracks WHERE id = ?1", [id], track_from_row)
        .optional()?
        .ok_or(AppError::TrackNotFound(id))
}

const SORTABLE: &[(&str, &str)] = &[
    ("title", "title COLLATE NOCASE"),
    ("artist", "artist COLLATE NOCASE"),
    ("album", "album COLLATE NOCASE"),
    ("genre", "genre COLLATE NOCASE"),
    ("year", "year"),
    ("duration_ms", "duration_ms"),
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
    limit: i64,
    offset: i64,
) -> AppResult<Vec<Track>> {
    let order = order_by(sort);
    let trimmed = query.map(str::trim).filter(|q| !q.is_empty());
    let mut tracks = Vec::new();
    match trimmed {
        Some(q) => {
            let sql = format!(
                "SELECT * FROM tracks
                 WHERE id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?1)
                 ORDER BY {order} LIMIT ?2 OFFSET ?3"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![fts_expr(q), limit, offset], track_from_row)?;
            for row in rows {
                tracks.push(row?);
            }
        }
        None => {
            let sql = format!("SELECT * FROM tracks ORDER BY {order} LIMIT ?1 OFFSET ?2");
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![limit, offset], track_from_row)?;
            for row in rows {
                tracks.push(row?);
            }
        }
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

pub fn get_track_by_uri(conn: &Connection, uri: &str) -> AppResult<Option<Track>> {
    Ok(conn
        .query_row("SELECT * FROM tracks WHERE uri = ?1", [uri], track_from_row)
        .optional()?)
}

/// Record a successful load: bump play_count and append to history.
pub fn record_play(conn: &Connection, track_id: i64, played_at: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE tracks SET play_count = play_count + 1 WHERE id = ?1",
        [track_id],
    )?;
    conn.execute(
        "INSERT INTO history(track_id, played_at, deck) VALUES (?1, ?2, 'main')",
        params![track_id, played_at],
    )?;
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

    #[test]
    fn migration_creates_schema_and_fts() {
        let conn = mem_db();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 1);
        // FTS5 table exists and is queryable
        let count: i64 = conn
            .query_row("SELECT count(*) FROM tracks_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn insert_dedupes_by_uri() {
        let conn = mem_db();
        let t = new_track("Stairway to Heaven", "Led Zeppelin", "/music/stairway.flac");
        assert!(insert_track(&conn, &t, 1).unwrap());
        assert!(!insert_track(&conn, &t, 2).unwrap(), "same uri must be skipped");
        let all = list_tracks(&conn, None, None, 100, 0).unwrap();
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

        let zep = list_tracks(&conn, Some("zeppelin"), None, 100, 0).unwrap();
        assert_eq!(zep.len(), 2);
        // prefix search
        let stair = list_tracks(&conn, Some("stair"), None, 100, 0).unwrap();
        assert_eq!(stair.len(), 1);
        assert_eq!(stair[0].title.as_deref(), Some("Stairway to Heaven"));
        // FTS metacharacters must not inject syntax errors
        let weird = list_tracks(&conn, Some("\"AND( near:*"), None, 100, 0);
        assert!(weird.is_ok());
    }

    #[test]
    fn sort_is_whitelisted() {
        let conn = mem_db();
        insert_track(&conn, &new_track("B side", "X", "/m/1.mp3"), 1).unwrap();
        insert_track(&conn, &new_track("A side", "X", "/m/2.mp3"), 2).unwrap();
        let sorted = list_tracks(&conn, None, Some("title:asc"), 100, 0).unwrap();
        assert_eq!(sorted[0].title.as_deref(), Some("A side"));
        // unknown field falls back instead of injecting SQL
        let fallback = list_tracks(&conn, None, Some("evil; DROP TABLE tracks:asc"), 100, 0);
        assert!(fallback.is_ok());
    }

    #[test]
    fn capability_round_trips() {
        let conn = mem_db();
        let mut t = new_track("Radio Stream", "Station", "radio://example");
        t.capability = Capability::StreamPlayable;
        insert_track(&conn, &t, 1).unwrap();
        let all = list_tracks(&conn, None, None, 10, 0).unwrap();
        assert_eq!(all[0].capability, Capability::StreamPlayable);
    }
}
