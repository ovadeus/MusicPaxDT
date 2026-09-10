pub mod ai;
pub mod audio;
pub mod commands;
pub mod controls;
pub mod enrich;
pub mod error;
pub mod library;
pub mod net;
pub mod now_playing;
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
    //
    // Prefer a fixed port so the webview origin is stable across launches —
    // otherwise a fresh random port changes the origin and silently wipes all
    // localStorage-persisted UI state on every restart. Fall back to a random
    // free port only if the fixed one is already taken.
    const UI_PORT: u16 = 17_432;
    let port = if portpicker::is_free_tcp(UI_PORT) {
        UI_PORT
    } else {
        portpicker::pick_unused_port().unwrap_or(UI_PORT)
    };

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());
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
                broadcaster: Arc::new(audio::broadcast::Broadcaster::default()),
                viz_capture: std::sync::Mutex::new(None),
                screen_audio: std::sync::Mutex::new(None),
            });

            let url = if cfg!(dev) {
                tauri::WebviewUrl::App("index.html".into())
            } else {
                tauri::WebviewUrl::External(format!("http://localhost:{port}").parse()?)
            };
            tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("MUSICPAX")
                .inner_size(1280.0, 800.0)
                .min_inner_size(1080.0, 720.0)
                // Tauri's native drag-drop handler intercepts all drag events in
                // the webview, silently breaking HTML5 drag-and-drop (playlist
                // reorder). We never use tauri://drag-drop (imports go through
                // dialog pickers), so hand DnD back to the page.
                .disable_drag_drop_handler()
                .build()?;

            // Menu-bar tray mini-controller + global Play/Pause hotkey.
            controls::init(app);
            // macOS Now Playing: Control Center / media-key transport handlers.
            now_playing::register_remote_commands(&app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_folder,
            commands::list_tracks,
            commands::update_track_metadata,
            commands::set_track_favorite,
            commands::set_now_playing,
            commands::delete_track,
            commands::delete_tracks,
            commands::record_play,
            commands::read_image_data_url,
            commands::artist_bio,
            commands::set_artist_bio,
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
            commands::set_input_gain,
            commands::set_visualizer,
            commands::start_viz_capture,
            commands::stop_viz_capture,
            commands::check_missing_files,
            commands::relink_track,
            commands::start_screen_audio,
            commands::stop_screen_audio,
            commands::set_mini_window,
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
            commands::streams::import_direct_stream,
            commands::streams::mirror_playlist,
            commands::streams::ai_build_playlist,
            commands::streams::repair_streams,
            commands::streams::reresolve_stream,
            commands::streams::radio_top,
            commands::streams::radio_search,
            commands::streams::resolve_radio_stream,
            commands::streams::import_radio_station,
            commands::streams::musicpax_feed,
            commands::streams::list_playlists,
            commands::streams::create_playlist,
            commands::streams::playlist_tracks,
            commands::streams::reorder_playlists,
            commands::streams::list_playlist_folders,
            commands::streams::create_playlist_folder,
            commands::streams::rename_playlist_folder,
            commands::streams::delete_playlist_folder,
            commands::streams::set_folder_collapsed,
            commands::streams::move_playlist_to_folder,
            commands::streams::reorder_playlist_folders,
            commands::streams::add_to_playlist,
            commands::streams::delete_playlist,
            commands::streams::rename_playlist,
            commands::streams::import_mpx_playlist,
            commands::share::share_playlist,
            commands::streams::youtube_search,
            commands::enrich::enrich_integration_status,
            commands::enrich::set_acoustid_key,
            commands::enrich::set_anthropic_key,
            commands::enrich::set_openai_key,
            commands::enrich::set_gemini_key,
            commands::enrich::propose_enrichment,
            commands::enrich::lookup_track_tags,
            commands::enrich::clean_track_metadata,
            commands::enrich::apply_enrichment,
            commands::enrich::enrich_cost_estimate,
            commands::enrich::ai_assistant_status,
            commands::enrich::ai_assistant_propose,
            commands::enrich::ollama_models,
            commands::broadcast::get_broadcast_config,
            commands::broadcast::set_broadcast_password,
            commands::broadcast::go_live_start,
            commands::broadcast::go_live_stop,
            commands::broadcast::go_live_status,
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
