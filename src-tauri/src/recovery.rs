// Copies of unsaved work, for when the program ends without being closed (see
// recovery.js, which says what is in them and when): files in a folder of the
// program's own, recovery/, each of one page of one run - `<run>-<page>.vertex`.
//
// A run holds a file of its own open, `<run>.lock`, that nobody else can open
// meanwhile: the system lets go of it however the run ends. So a copy whose
// run's lock can be opened is left over - as is one of a page of this very
// run that is there no more (it was loaded anew).

use crate::files::{Folder, failure, header, write_whole};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request, Response};

pub struct Recovery {
    folder: PathBuf,
    run: String,
    lock: Mutex<Option<File>>,
    page: Mutex<Option<String>>, // the copy of the page that is there now
}

fn now() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or(0)
}

fn open_alone(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options.open(path)
}

impl Recovery {
    pub fn new(data: &Folder) -> Self {
        let folder = data.0.join("recovery");
        let run = format!("{}_{}", std::process::id(), now());
        let _ = std::fs::create_dir_all(&folder);
        let lock = open_alone(&folder.join(format!("{run}.lock"))).ok();
        Self { folder, run, lock: Mutex::new(lock), page: Mutex::new(None) }
    }

    // A copy's file: by its name, and nothing but a copy.
    fn file(&self, name: &str) -> Result<PathBuf, String> {
        let sound = name.strip_suffix(".vertex").is_some_and(|stem| !stem.is_empty() && stem.chars().all(|c| c.is_ascii_digit() || c == '_' || c == '-'));
        if sound { Ok(self.folder.join(name)) } else { Err("not a name".into()) }
    }

    // Whether the run that made a copy is still going on.
    fn going(&self, run: &str) -> bool {
        let lock = self.folder.join(format!("{run}.lock"));
        if !lock.exists() {
            return false;
        }
        match open_alone(&lock) {
            Ok(file) => {
                drop(file);
                let _ = std::fs::remove_file(&lock);
                false
            }
            Err(_) => true,
        }
    }

    // The window has closed as it should: its page's copy is not wanted.
    // (`kept`: it closed with unsaved changes nobody was asked about - the system shutting down.)
    pub fn end(&self, kept: bool) {
        if let (Some(name), false) = (self.page.lock().unwrap().take(), kept) {
            let _ = std::fs::remove_file(self.folder.join(name));
        }
        drop(self.lock.lock().unwrap().take());
        let _ = std::fs::remove_file(self.folder.join(format!("{}.lock", self.run)));
    }
}

// A page starts: the name of its copy.
#[tauri::command]
pub fn recovery_begin(recovery: tauri::State<Recovery>) -> String {
    let name = format!("{}-{}.vertex", recovery.run, now());
    *recovery.page.lock().unwrap() = Some(name.clone());
    name
}

// The copies left over, the latest first.
#[tauri::command]
pub async fn recovery_list(recovery: tauri::State<'_, Recovery>) -> Result<Vec<String>, String> {
    let page = recovery.page.lock().unwrap().clone();
    let Ok(entries) = std::fs::read_dir(&recovery.folder) else { return Ok(vec![]) };
    let mut found: Vec<(SystemTime, String)> = vec![];
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if let Some(run) = name.strip_suffix(".lock") {
            if run != recovery.run {
                recovery.going(run); // (what a run that is over has left goes)
            }
            continue;
        }
        if recovery.file(&name).is_err() || Some(&name) == page.as_ref() {
            continue;
        }
        let run = name.split('-').next().unwrap_or("");
        if run != recovery.run && recovery.going(run) {
            continue;
        }
        found.push((entry.metadata().and_then(|data| data.modified()).unwrap_or(UNIX_EPOCH), name));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(found.into_iter().map(|(_, name)| name).collect())
}

#[tauri::command]
pub async fn recovery_read(recovery: tauri::State<'_, Recovery>, name: String) -> Result<Response, String> {
    std::fs::read(recovery.file(&name)?).map(Response::new).map_err(failure)
}

#[tauri::command]
pub async fn recovery_write(recovery: tauri::State<'_, Recovery>, request: Request<'_>) -> Result<(), String> {
    let target = recovery.file(&header(&request, "name")?)?;
    let InvokeBody::Raw(bytes) = request.body() else { return Err("no bytes".into()) };
    write_whole(&target, bytes).map_err(failure)
}

#[tauri::command]
pub async fn recovery_remove(recovery: tauri::State<'_, Recovery>, name: String) -> Result<(), String> {
    match std::fs::remove_file(recovery.file(&name)?) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}
