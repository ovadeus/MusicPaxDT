//! "Go Live" commands — drive the Icecast source broadcaster. Non-secret
//! connection settings live in the `settings` table; the source password lives
//! only in the OS keychain. Going live is always user-triggered.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::audio::broadcast::{BroadcastStatus, IcecastConfig};
use crate::error::{AppError, AppResult};
use crate::library::db;
use crate::net::{keyring_get, keyring_set};
use crate::state::{lock_unpoisoned, AppState};

const PW_KEY: &str = "radioking_source_password";

/// Non-secret live connection settings (everything except the password).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastConfig {
    pub host: String,
    pub port: u16,
    pub mount: String,
    pub username: String,
    pub bitrate: u32,
    pub name: String,
    pub description: String,
    pub genre: String,
    pub url: String,
    pub public: bool,
}

impl Default for BroadcastConfig {
    fn default() -> Self {
        BroadcastConfig {
            host: String::new(),
            port: 8000,
            mount: String::new(),
            username: "source".into(),
            bitrate: 128,
            name: String::new(),
            description: String::new(),
            genre: String::new(),
            url: String::new(),
            public: false,
        }
    }
}

/// What the UI loads to prefill the form: the saved config plus whether a
/// password is already stored (we never return the password itself).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastSettings {
    #[serde(flatten)]
    pub config: BroadcastConfig,
    pub has_password: bool,
}

fn get(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    db::get_setting(conn, key).ok().flatten()
}

fn read_config(conn: &rusqlite::Connection) -> BroadcastConfig {
    let d = BroadcastConfig::default();
    BroadcastConfig {
        host: get(conn, "live.host").unwrap_or(d.host),
        port: get(conn, "live.port").and_then(|s| s.parse().ok()).unwrap_or(d.port),
        mount: get(conn, "live.mount").unwrap_or(d.mount),
        username: get(conn, "live.username").unwrap_or(d.username),
        bitrate: get(conn, "live.bitrate").and_then(|s| s.parse().ok()).unwrap_or(d.bitrate),
        name: get(conn, "live.name").unwrap_or(d.name),
        description: get(conn, "live.description").unwrap_or(d.description),
        genre: get(conn, "live.genre").unwrap_or(d.genre),
        url: get(conn, "live.url").unwrap_or(d.url),
        public: get(conn, "live.public").map(|s| s == "true").unwrap_or(d.public),
    }
}

fn write_config(conn: &rusqlite::Connection, c: &BroadcastConfig) -> AppResult<()> {
    db::set_setting(conn, "live.host", c.host.trim())?;
    db::set_setting(conn, "live.port", &c.port.to_string())?;
    db::set_setting(conn, "live.mount", c.mount.trim())?;
    db::set_setting(conn, "live.username", c.username.trim())?;
    db::set_setting(conn, "live.bitrate", &c.bitrate.to_string())?;
    db::set_setting(conn, "live.name", c.name.trim())?;
    db::set_setting(conn, "live.description", c.description.trim())?;
    db::set_setting(conn, "live.genre", c.genre.trim())?;
    db::set_setting(conn, "live.url", c.url.trim())?;
    db::set_setting(conn, "live.public", if c.public { "true" } else { "false" })?;
    Ok(())
}

#[tauri::command]
pub async fn get_broadcast_config(state: State<'_, AppState>) -> AppResult<BroadcastSettings> {
    let conn = lock_unpoisoned(&state.db);
    Ok(BroadcastSettings {
        config: read_config(&conn),
        has_password: keyring_get(PW_KEY).is_some(),
    })
}

/// Persist the source password to the OS keychain. Empty clears it.
#[tauri::command]
pub fn set_broadcast_password(password: String) -> AppResult<()> {
    keyring_set(PW_KEY, password.trim()).map_err(AppError::Other)
}

/// Start broadcasting. Saves the (non-secret) config, reads the password from
/// the keychain, and spawns the source client. Progress arrives via the
/// `broadcast-state` event.
#[tauri::command]
pub async fn go_live_start(
    config: BroadcastConfig,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<BroadcastStatus> {
    if config.host.trim().is_empty() {
        return Err(AppError::Other(
            "Enter your Radio King server host (Radio King → Live tab)".into(),
        ));
    }
    let password = keyring_get(PW_KEY).unwrap_or_default();
    if password.is_empty() {
        return Err(AppError::Other(
            "Enter your source password first (Radio King → Live tab)".into(),
        ));
    }

    {
        let conn = lock_unpoisoned(&state.db);
        write_config(&conn, &config)?;
    }

    let username = config.username.trim();
    let icecast = IcecastConfig {
        host: config.host.trim().to_string(),
        port: config.port,
        mount: config.mount.trim().to_string(),
        username: if username.is_empty() { "source".into() } else { username.to_string() },
        password,
        bitrate: config.bitrate,
        name: config.name.trim().to_string(),
        description: config.description.trim().to_string(),
        genre: config.genre.trim().to_string(),
        url: config.url.trim().to_string(),
        public: config.public,
    };

    state
        .broadcaster
        .start(state.engine.shared.clone(), icecast, app);
    Ok(state.broadcaster.status())
}

#[tauri::command]
pub async fn go_live_stop(state: State<'_, AppState>) -> AppResult<BroadcastStatus> {
    state.broadcaster.stop(&state.engine.shared);
    Ok(state.broadcaster.status())
}

#[tauri::command]
pub async fn go_live_status(state: State<'_, AppState>) -> AppResult<BroadcastStatus> {
    Ok(state.broadcaster.status())
}
