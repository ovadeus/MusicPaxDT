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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = library::db::open(&data_dir.join("stack.db"))?;
            let engine = Arc::new(audio::engine::EngineHandle::new()?);
            audio::meters::spawn_emitter(app.handle().clone(), engine.shared.clone());
            app.manage(state::AppState {
                db: Arc::new(Mutex::new(conn)),
                engine,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_folder,
            commands::list_tracks,
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
