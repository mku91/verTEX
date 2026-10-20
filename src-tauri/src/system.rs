// The page's dealings with the rest of the computer: a folder watched for
// what other programs write into it, files opened in other programs, shown in
// the file manager.

use std::path::PathBuf;
use std::sync::Mutex;
use notify::{RecursiveMode, Watcher};
use tauri::{Emitter, WebviewWindow};

// One watched folder per window (its project's atlas files, see host.js);
// what changes in it goes to the window as 'folder:changed', the file's name.
#[derive(Default)]
pub struct Watching(Mutex<std::collections::HashMap<String, notify::RecommendedWatcher>>);

#[tauri::command]
pub fn folder_watch(window: WebviewWindow, watching: tauri::State<Watching>, path: Option<PathBuf>) -> Result<(), String> {
    let mut all = watching.0.lock().unwrap();
    all.remove(window.label()); // (the one before, if any, stops)
    let Some(path) = path else { return Ok(()) };
    let target = window.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        for file in event.paths.iter().filter_map(|path| path.file_name()?.to_str()) {
            let _ = target.emit_to(target.label(), "folder:changed", file);
        }
    })
    .map_err(|error| error.to_string())?;
    watcher.watch(&path, RecursiveMode::NonRecursive).map_err(|error| error.to_string())?;
    all.insert(window.label().into(), watcher);
    Ok(())
}

// In the program the system has for such files.
#[tauri::command]
pub async fn open_path(path: PathBuf) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|error| error.to_string())
}

// The user's program (the path of its executable) started on the file: on its
// own, it outlives this window, and what it prints is nobody's to read.
#[tauri::command]
pub async fn open_with(program: PathBuf, path: PathBuf) -> Result<(), String> {
    std::process::Command::new(program)
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn reveal(path: PathBuf) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|error| error.to_string())
}
