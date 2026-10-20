// What the page may do with files: read one, write one, ask the user for one.
// The rest - what the files are, where they go - is the page's (see host.js).
//
// Bytes travel as they are, not as JSON: a file read comes back as an
// ArrayBuffer, one written goes as the request's body with its path in a
// header (URI-encoded: a path may be in any letters).

use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri_plugin_dialog::DialogExt;

// An error the page can tell apart: a file that is not there is "missing".
fn failure(error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "missing".into(),
        _ => error.to_string(),
    }
}

fn header_path(request: &Request) -> Result<PathBuf, String> {
    let raw = request.headers().get("path").and_then(|value| value.to_str().ok()).ok_or("no path")?;
    Ok(PathBuf::from(percent_decode(raw)?))
}

fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

// Written beside the target and moved over it, so that a failure half-way
// leaves the previous version of the file whole.
pub fn write_whole(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(folder) = target.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let mut temporary = target.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(temporary);
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, target).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

#[tauri::command]
pub async fn file_read(path: PathBuf) -> Result<Response, String> {
    std::fs::read(path).map(Response::new).map_err(failure)
}

#[tauri::command]
pub async fn file_write(request: Request<'_>) -> Result<(), String> {
    let target = header_path(&request)?;
    let InvokeBody::Raw(bytes) = request.body() else { return Err("no bytes".into()) };
    write_whole(&target, bytes).map_err(failure)
}

#[derive(serde::Deserialize)]
pub struct Filter {
    name: String,
    extensions: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    title: String,
    #[serde(default)]
    filters: Vec<Filter>,
    default_name: Option<String>,
}

fn dialog(window: &tauri::WebviewWindow, ask: &Ask) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut dialog = window.dialog().file().set_parent(window).set_title(&ask.title);
    for filter in &ask.filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    if let Some(name) = &ask.default_name {
        dialog = dialog.set_file_name(name);
    }
    dialog
}

// Where to save: the path chosen, or None if the user cancelled.
#[tauri::command]
pub async fn ask_save(window: tauri::WebviewWindow, ask: Ask) -> Option<String> {
    dialog(&window, &ask).blocking_save_file().and_then(|file| file.into_path().ok()).map(|path| path.display().to_string())
}

// Which file to open: as ask_save.
#[tauri::command]
pub async fn ask_open(window: tauri::WebviewWindow, ask: Ask) -> Option<String> {
    dialog(&window, &ask).blocking_pick_file().and_then(|file| file.into_path().ok()).map(|path| path.display().to_string())
}

// The program's own folder (see main.rs): small files kept between launches.
pub struct Folder(pub PathBuf);

fn own(folder: &Folder, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("not a name".into());
    }
    Ok(folder.0.join(name))
}

#[tauri::command]
pub async fn data_read(folder: tauri::State<'_, Folder>, name: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(own(&folder, &name)?) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn data_write(folder: tauri::State<'_, Folder>, name: String, text: String) -> Result<(), String> {
    write_whole(&own(&folder, &name)?, text.as_bytes()).map_err(failure)
}

// A folder's entries' names; none if there is no such folder.
#[tauri::command]
pub async fn folder_list(path: PathBuf) -> Vec<String> {
    std::fs::read_dir(path)
        .map(|entries| entries.filter_map(|entry| entry.ok()?.file_name().into_string().ok()).collect())
        .unwrap_or_default()
}

// When a file was last written, in ms since 1970; None if it is not there.
#[tauri::command]
pub async fn file_modified(path: PathBuf) -> Option<f64> {
    let time = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(time.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0)
}

#[tauri::command]
pub async fn folder_make(path: PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(failure)
}

#[tauri::command]
pub async fn file_copy(from: PathBuf, to: PathBuf) -> Result<(), String> {
    std::fs::copy(from, to).map(|_| ()).map_err(failure)
}

// A file or a whole folder; one that is not there is no failure.
#[tauri::command]
pub async fn path_remove(path: PathBuf) -> Result<(), String> {
    let result = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
    match result {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

// Into the Recycle Bin (where it can be brought back from), not gone for good.
#[tauri::command]
pub async fn path_trash(path: PathBuf) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    trash::delete(path).map_err(|error| error.to_string())
}

// The system's folder for temporary files.
#[tauri::command]
pub fn temp_folder() -> String {
    std::env::temp_dir().display().to_string()
}
