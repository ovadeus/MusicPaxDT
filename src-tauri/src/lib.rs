pub mod audio;
pub mod commands;
pub mod error;
pub mod library;
pub mod sources;
pub mod state;

use std::sync::{Arc, Mutex};

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // In production the UI is served over http://localhost:<port> instead of
    // the tauri:// custom protocol — YouTube embeds require a real HTTP
    // referrer (player error 153 otherwise). Dev mode already runs on the
    // Vite server, so the plugin is release-only.
    let port = portpicker::pick_unused_port().unwrap_or(17_432);

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    if !cfg!(dev) {
        builder = builder.plugin(tauri_plugin_localhost::Builder::new(port).build());
    }

    let app = builder
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = library::db::open(&data_dir.join("stack.db"))?;
            let engine = Arc::new(audio::engine::EngineHandle::new()?);
            audio::meters::spawn_emitter(app.handle().clone(), engine.shared.clone());
            app.manage(state::AppState {
                db: Arc::new(Mutex::new(conn)),
                engine,
            });

            let url = if cfg!(dev) {
                tauri::WebviewUrl::App("index.html".into())
            } else {
                tauri::WebviewUrl::External(format!("http://localhost:{port}").parse()?)
            };
            tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("MUSICPAX")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_folder,
            commands::list_tracks,
            commands::update_track_metadata,
            commands::get_audio_devices,
            commands::set_output_device,
            commands::load_track,
            commands::play,
            commands::pause,
            commands::stop,
            commands::seek,
            commands::set_volume,
            commands::now_playing,
            commands::get_audio_input_devices,
            commands::start_line_in,
            commands::set_input_device,
            commands::set_riaa,
            commands::set_tone,
            commands::engine_status,
            commands::start_recording,
            commands::stop_recording,
            commands::get_settings,
            commands::set_setting,
            commands::recording_format_label,
            commands::streams::integration_status,
            commands::streams::set_youtube_api_key,
            commands::streams::set_spotify_credentials,
            commands::streams::import_stream_url,
            commands::streams::mirror_playlist,
            commands::streams::list_playlists,
            commands::streams::create_playlist,
            commands::streams::playlist_tracks,
            commands::streams::add_to_playlist,
            commands::streams::delete_playlist,
        ])
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|_, _| {}),
        Err(e) => {
            eprintln!("failed to start STACK: {e}");
            std::process::exit(1);
        }
    }
}
