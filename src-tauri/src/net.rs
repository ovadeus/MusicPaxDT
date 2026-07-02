//! Shared HTTP client and OS-keychain helpers used by the streaming and
//! enrichment subsystems.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const KEYRING_SERVICE: &str = "org.stack.app";

/// In-process cache of keychain reads. The app isn't code-signed when built
/// locally, so macOS can't verify it and prompts for the login-keychain
/// password on EVERY read. We read each secret at most once per launch and
/// serve the rest from here, so the prompt appears at most once per key.
fn keyring_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A single shared reqwest client (connection pool, sane timeout, UA that
/// identifies STACK to MusicBrainz/AcoustID as their etiquette requests).
pub fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("STACK/0.1 (https://github.com/stack-app; open-source desktop music system)")
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default()
    })
}

/// Read a secret from the OS keychain (cached per launch); None when unset.
pub fn keyring_get(name: &str) -> Option<String> {
    {
        let cache = keyring_cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(v) = cache.get(name) {
            return v.clone();
        }
    }
    let value = keyring::Entry::new(KEYRING_SERVICE, name)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|s| !s.is_empty());
    keyring_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(name.to_string(), value.clone());
    value
}

/// Store (or, when value is empty, delete) a secret in the OS keychain.
pub fn keyring_set(name: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, name)
        .map_err(|e| format!("keychain unavailable: {e}"))?;
    let result = if value.is_empty() {
        let _ = entry.delete_credential();
        Ok(())
    } else {
        entry
            .set_password(value)
            .map_err(|e| format!("keychain write failed: {e}"))
    };
    if result.is_ok() {
        // Keep the cache in step so a freshly-saved key needs no re-read.
        let cached = (!value.is_empty()).then(|| value.to_string());
        keyring_cache()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(name.to_string(), cached);
    }
    result
}
