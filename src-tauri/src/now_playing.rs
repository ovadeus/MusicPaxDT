//! macOS "Now Playing" integration: publishes the current track to the system
//! (Control Center, the menu-bar Now Playing widget, the lock screen) and wires
//! the hardware media keys / Control Center transport buttons back into the app
//! via the same `media-command` event the tray and global hotkey use.
//!
//! MediaPlayer's `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` are only
//! touched on the main thread (Tauri's `run_on_main_thread`). Non-macOS builds
//! get no-op stubs so the rest of the app is platform-agnostic.

use serde::Deserialize;

/// What the frontend pushes whenever the track or play-state changes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingMeta {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<f64>,
    pub position_ms: Option<f64>,
    pub playing: bool,
}

#[cfg(target_os = "macos")]
pub use imp::{register_remote_commands, update};

#[cfg(not(target_os = "macos"))]
pub fn register_remote_commands(_app: &tauri::AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub fn update(_app: &tauri::AppHandle, _meta: NowPlayingMeta) {}

#[cfg(target_os = "macos")]
mod imp {
    use super::NowPlayingMeta;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSNumber, NSObject, NSString};
    use objc2_media_player::{
        MPMediaItemPropertyAlbumTitle, MPMediaItemPropertyArtist,
        MPMediaItemPropertyPlaybackDuration, MPMediaItemPropertyTitle, MPNowPlayingInfoCenter,
        MPNowPlayingInfoPropertyElapsedPlaybackTime, MPNowPlayingInfoPropertyPlaybackRate,
        MPNowPlayingPlaybackState, MPRemoteCommandCenter, MPRemoteCommandEvent,
        MPRemoteCommandHandlerStatus,
    };
    use tauri::{AppHandle, Emitter};

    // NSString → NSObject (one level up); values share NSObject as the common
    // dictionary value type.
    fn str_val(s: &str) -> Retained<NSObject> {
        Retained::into_super(NSString::from_str(s))
    }

    // NSNumber → NSValue → NSObject (two levels up).
    fn num_val(n: f64) -> Retained<NSObject> {
        Retained::into_super(Retained::into_super(NSNumber::new_f64(n)))
    }

    /// Publish the current track + play state to the system.
    pub fn update(app: &AppHandle, meta: NowPlayingMeta) {
        let _ = app.run_on_main_thread(move || unsafe {
            let center = MPNowPlayingInfoCenter::defaultCenter();

            let mut keys: Vec<&NSString> = Vec::new();
            let mut vals: Vec<Retained<NSObject>> = Vec::new();
            let mut push = |key: &'static NSString, val: Retained<NSObject>| {
                keys.push(key);
                vals.push(val);
            };
            if let Some(t) = meta.title.as_deref() {
                push(MPMediaItemPropertyTitle, str_val(t));
            }
            if let Some(a) = meta.artist.as_deref() {
                push(MPMediaItemPropertyArtist, str_val(a));
            }
            if let Some(al) = meta.album.as_deref() {
                push(MPMediaItemPropertyAlbumTitle, str_val(al));
            }
            if let Some(d) = meta.duration_ms {
                push(MPMediaItemPropertyPlaybackDuration, num_val(d / 1000.0));
            }
            if let Some(p) = meta.position_ms {
                push(
                    MPNowPlayingInfoPropertyElapsedPlaybackTime,
                    num_val(p / 1000.0),
                );
            }
            push(
                MPNowPlayingInfoPropertyPlaybackRate,
                num_val(if meta.playing { 1.0 } else { 0.0 }),
            );

            let val_refs: Vec<&AnyObject> =
                vals.iter().map(|v| AsRef::<AnyObject>::as_ref(&**v)).collect();
            let dict = NSDictionary::from_slices(&keys, &val_refs);
            center.setNowPlayingInfo(Some(&dict));
            center.setPlaybackState(if meta.playing {
                MPNowPlayingPlaybackState::Playing
            } else {
                MPNowPlayingPlaybackState::Paused
            });
        });
    }

    /// Register the Control Center / media-key handlers once, at startup.
    pub fn register_remote_commands(app: &AppHandle) {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || unsafe {
            let center = MPRemoteCommandCenter::sharedCommandCenter();

            let bind = |cmd: &objc2_media_player::MPRemoteCommand, action: &'static str| {
                let app = app.clone();
                let handler = RcBlock::new(move |_ev: core::ptr::NonNull<MPRemoteCommandEvent>| {
                    let _ = app.emit("media-command", action);
                    MPRemoteCommandHandlerStatus::Success
                });
                cmd.setEnabled(true);
                cmd.addTargetWithHandler(&handler);
            };

            bind(&center.playCommand(), "play");
            bind(&center.pauseCommand(), "pause");
            bind(&center.togglePlayPauseCommand(), "playpause");
            bind(&center.nextTrackCommand(), "next");
            bind(&center.previousTrackCommand(), "prev");
        });
    }
}
