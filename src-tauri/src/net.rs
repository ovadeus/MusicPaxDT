//! Shared HTTP client and OS-keychain helpers used by the streaming and
//! enrichment subsystems.

use std::sync::OnceLock;
use std::time::Duration;

pub const KEYRING_SERVICE: &str = "org.stack.app";

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

/// Read a secret from the OS keychain; None when unset or empty.
pub fn keyring_get(name: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, name)
        .ok()?
        .get_password()
        .ok()
        .filter(|s| !s.is_empty())
}

/// Store (or, when value is empty, delete) a secret in the OS keychain.
pub fn keyring_set(name: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, name)
        .map_err(|e| format!("keychain unavailable: {e}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        Ok(())
    } else {
        entry
            .set_password(value)
            .map_err(|e| format!("keychain write failed: {e}"))
    }
}
