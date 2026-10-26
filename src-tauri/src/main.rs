// verTEX's window: the editor is a web page (src/renderer), this is the little
// around it - its windows and menu, the interface's language, the questions
// asked before closing. What the page needs of the computer (files, folders,
// other programs) it asks for by commands, see host.js on its side.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod locale;
mod menu;
mod system;
mod update;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const MAIN: &str = "main";
const BACKGROUND: Color = Color(0x28, 0x2a, 0x36, 0xff); // the default theme's, shown until the page paints

// What the windows say of themselves.
#[derive(Default)]
struct Windows {
    dirty: Mutex<HashSet<String>>,   // with unsaved changes: asked about before they close
    closing: Mutex<HashSet<String>>, // told to close regardless
}

// The program's own folder: settings kept between launches (the language, the
// recent projects). The one Electron's verTEX had, so that they carry over.
// A second copy, started to try something out beside the one being worked in,
// is given a folder of its own (VERTEX_PROFILE), and its page one too.
fn profile() -> (PathBuf, Option<PathBuf>) {
    match std::env::var_os("VERTEX_PROFILE") {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            (dir.clone(), Some(dir.join("webview")))
        }
        None => (dirs_config().join("verTEX"), None),
    }
}

fn dirs_config() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

// Development builds open a local debugging port (this machine only), so that
// the state of a running window can be inspected from outside; a second copy
// is given a port of its own (VERTEX_DEBUG_PORT), the two must not be mistaken.
// WebView2 wants every window of the program started with the same arguments.
fn browser_args() -> String {
    let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    let port = std::env::var("VERTEX_DEBUG_PORT").ok().or_else(|| cfg!(debug_assertions).then(|| "19333".into())); // (not 9333: other programs on this machine take that one)
    if let Some(port) = port {
        args.push_str(&format!(" --remote-debugging-port={port}"));
    }
    args
}

// The page's window: the welcome screen at first, the editor then.
fn open_main(app: &tauri::AppHandle, webview_dir: Option<PathBuf>) -> tauri::Result<WebviewWindow> {
    let language = app.state::<locale::Language>();
    let opener = app.clone();
    let views_dir = webview_dir.clone();
    let mut builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("src/renderer/index.html".into()))
        .title("verTEX")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .center()
        .background_color(BACKGROUND)
        // Shown when the page has drawn its splash (window_ready), not before:
        // until then a window shows the blank colours of a webview starting.
        .visible(false)
        .menu(menu::build(app, &language)?)
        .additional_browser_args(&browser_args())
        .initialization_script(language.script(&app.package_info().version.to_string()))
        // The page reads pictures from the clipboard (pasted into the UV
        // editor): allowed without asking, as the browser would ask a site.
        // Only that - what else a page may ask for is asked about as before.
        .enable_clipboard_access()
        .on_page_load(|_, payload| match payload.event() {
            PageLoadEvent::Started => stage("page"),
            PageLoadEvent::Finished => stage("page-done"),
        })
        // The window is called as its page is: the project's name.
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        // The page opens one window of its own: its views (see views-window.js),
        // which it draws into itself - so the window is the page's child, with
        // the page as its opener. Nothing else.
        .on_new_window(move |url, features| {
            if !url.path().ends_with("/views.html") {
                return NewWindowResponse::Deny;
            }
            match open_views(&opener, features, views_dir.clone()) {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        });
    if let Some(dir) = webview_dir {
        builder = builder.data_directory(dir);
    }
    let window = builder.build()?;
    // The welcome screen has no menu bar (its keys work all the same); the editor gets it, see window_editing.
    window.hide_menu()?;
    Ok(window)
}

static VIEWS: AtomicUsize = AtomicUsize::new(0);

fn open_views(app: &tauri::AppHandle, features: tauri::webview::NewWindowFeatures, webview_dir: Option<PathBuf>) -> tauri::Result<WebviewWindow> {
    let language = app.state::<locale::Language>();
    let mut builder = WebviewWindowBuilder::new(app, format!("views-{}", VIEWS.fetch_add(1, Ordering::SeqCst)), WebviewUrl::External("about:blank".parse().unwrap()))
        .window_features(features)
        .title(language.t("window.views.title"))
        .inner_size(1280.0, 860.0)
        .background_color(BACKGROUND)
        .additional_browser_args(&browser_args());
    if let Some(dir) = webview_dir {
        builder = builder.data_directory(dir);
    }
    builder.build()
}

// How far the start has got, for npm start to show (scripts/start.mjs): a
// line of its own on the standard output. Development builds only.
fn stage(name: &str) {
    if cfg!(debug_assertions) {
        use std::io::Write;
        println!("[vertex] {name}");
        let _ = std::io::stdout().flush();
    }
}

// The page has drawn its first picture: the window can be seen.
#[tauri::command]
fn window_ready(window: WebviewWindow) {
    stage("shown");
    if !window.is_visible().unwrap_or(true) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// The page has all its scripts loaded: the editor is there.
#[tauri::command]
fn page_loaded() {
    stage("loaded");
}

// A project opened or made: the editor, maximized - the views want all the
// room there is - and with the menu bar. Back on the welcome screen, the menu
// bar goes; the window stays as it is.
#[tauri::command]
fn window_editing(window: WebviewWindow, on: bool) -> Result<(), String> {
    let result = if on {
        window.show_menu().and_then(|_| if window.is_maximized()? || window.is_fullscreen()? { Ok(()) } else { window.maximize() })
    } else {
        window.hide_menu()
    };
    result.map_err(|error| error.to_string())
}

// The window has unsaved changes or not; one that has them asks before it closes.
#[tauri::command]
fn project_state(window: WebviewWindow, windows: tauri::State<Windows>, dirty: bool) {
    let mut set = windows.dirty.lock().unwrap();
    if dirty { set.insert(window.label().into()) } else { set.remove(window.label()) };
}

// Closes the window with no more questions (the page has asked them).
#[tauri::command]
fn window_close(window: WebviewWindow, windows: tauri::State<Windows>) -> Result<(), String> {
    windows.closing.lock().unwrap().insert(window.label().into());
    window.close().map_err(|error| error.to_string())
}

fn main() {
    let (data, webview_dir) = profile();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::Updates::default())
        .manage(Windows::default())
        .manage(locale::Language::load(data.clone()))
        .manage(files::Folder(data))
        .manage(system::Watching::default())
        .invoke_handler(tauri::generate_handler![
            window_ready,
            page_loaded,
            window_editing,
            project_state,
            window_close,
            locale::locale_set,
            files::file_read,
            files::file_write,
            files::ask_save,
            files::ask_open,
            files::data_read,
            files::data_write,
            files::folder_list,
            files::file_modified,
            files::folder_make,
            files::file_copy,
            files::path_remove,
            files::path_trash,
            files::temp_folder,
            system::folder_watch,
            system::open_path,
            system::open_with,
            system::reveal,
            update::update_check,
            update::update_install,
        ])
        .setup(move |app| {
            update::start(app.handle()); // asked while the page loads
            let window = open_main(app.handle(), webview_dir.clone())?;
            window.on_menu_event(|window, event| menu::handle(window, event.id().as_ref()));
            // A page that never says it is ready must not leave the window unseen.
            let late = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                window_ready(late);
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // A window with unsaved changes hands the closing over to its page,
            // which asks the user and then closes for good (window_close) or stays.
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN => {
                let windows = window.state::<Windows>();
                if windows.closing.lock().unwrap().contains(MAIN) || !windows.dirty.lock().unwrap().contains(MAIN) {
                    return;
                }
                api.prevent_close();
                let _ = window.emit_to(MAIN, "menu", "project-close");
            }
            // With the editor's window go the others (its views).
            WindowEvent::Destroyed if window.label() == MAIN => window.app_handle().exit(0),
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("verTEX could not start");
}
