// Updates. As the program starts it asks GitHub whether there is a newer
// version (latest.json of the latest release, see scripts/release.mjs); the
// page, loaded, asks for the answer (update_check) and the user whether to
// take it. Taken (update_install), it is downloaded, its signature checked
// against the key built into the program, installed, and the program
// started anew - the installer does that, see tauri-plugin-updater.
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::OnceCell;

// How long the answer may take: the start waits for it. No network, no answer
// in time - the program starts as it is.
const WAIT: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct Updates {
    found: OnceCell<Option<Update>>,
}

// The newer version, if there is one. Development builds don't ask, unless
// told where to (VERTEX_UPDATE_URL, a latest.json of one's own to try it out).
async fn look(app: &AppHandle) -> Option<Update> {
    let mut builder = app.updater_builder().timeout(WAIT);
    match std::env::var("VERTEX_UPDATE_URL") {
        Ok(url) => builder = builder.endpoints(vec![url.parse().ok()?]).ok()?,
        Err(_) if cfg!(debug_assertions) => return None,
        Err(_) => {}
    }
    builder.build().ok()?.check().await.ok().flatten()
}

// Asked at once, while the page loads.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        app.state::<Updates>().found.get_or_init(|| look(&app)).await;
    });
}

#[derive(serde::Serialize)]
pub struct Found {
    version: String,
    notes: Option<String>,
}

// The newer version (waiting for the answer, if it has not come yet), or nothing.
#[tauri::command]
pub async fn update_check(app: AppHandle, updates: tauri::State<'_, Updates>) -> Result<Option<Found>, ()> {
    let found = updates.found.get_or_init(|| look(&app)).await;
    Ok(found.as_ref().map(|update| Found { version: update.version.clone(), notes: update.body.clone() }))
}

// Downloads the newer version and installs it; the program closes for that
// and the installer starts it again. How much has come is told to the page as
// it comes ("update-progress": [bytes, of how many or null]).
#[tauri::command]
pub async fn update_install(window: WebviewWindow, updates: tauri::State<'_, Updates>) -> Result<(), String> {
    let Some(Some(update)) = updates.found.get() else {
        return Err("no update".into());
    };
    let mut got = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                got += chunk as u64;
                let _ = window.emit_to(window.label(), "update-progress", (got, total));
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    window.app_handle().restart()
}
