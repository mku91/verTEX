// The window's menu. Its items talk to the page through a single 'menu' event.
//
// The shortcuts are shown here but handled in the page, where the user can
// rebind them (Settings -> Hotkeys), and where text fields keep their own
// Ctrl+Z. So no item is given an accelerator - Windows would take its keys
// from the page, the single letters too - its key is written after a tab
// instead, which the menu shows at the right as it would an accelerator's.

use crate::locale::Language;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Window, Wry};

pub fn build(app: &AppHandle, language: &Language) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, key: &str, shortcut: Option<&str>| {
        let label = match shortcut {
            Some(keys) => format!("{}\t{keys}", language.t(key)),
            None => language.t(key),
        };
        MenuItemBuilder::with_id(id, label).build(app)
    };
    let file = SubmenuBuilder::new(app, language.t("menu.file"))
        .item(&item("project-new", "menu.file.new", Some("Ctrl+N"))?)
        .item(&item("project-open", "menu.file.open", Some("Ctrl+O"))?)
        .separator()
        .item(&item("project-save", "menu.file.save", Some("Ctrl+S"))?)
        .item(&item("project-save-as", "menu.file.save-as", Some("Ctrl+Shift+S"))?)
        .item(&item("project-close-file", "menu.file.close", Some("Ctrl+Shift+Q"))?)
        .separator()
        .item(&item("export-gltf", "menu.file.export-gltf", None)?)
        .item(&item("render-sprites", "menu.file.render-sprites", None)?)
        .separator()
        .item(&item("settings", "menu.file.settings", Some("Ctrl+,"))?)
        .separator()
        .item(&item("quit", "menu.file.quit", Some("Alt+F4"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, language.t("menu.edit"))
        .item(&item("undo", "menu.edit.undo", Some("Ctrl+Z"))?)
        .item(&item("redo", "menu.edit.redo", Some("Ctrl+Y"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, language.t("menu.view"))
        .item(&item("toggle-views", "menu.view.views", Some("B"))?)
        .item(&item("frame", "menu.view.frame", Some("F"))?)
        .separator()
        .item(&item("reload", "menu.view.reload", Some("Ctrl+R"))?)
        .item(&item("devtools", "menu.view.devtools", Some("Ctrl+Shift+I"))?)
        .item(&item("fullscreen", "menu.view.fullscreen", Some("F11"))?)
        .build()?;
    MenuBuilder::new(app).items(&[&file, &edit, &view]).build()
}

// The window's own matters are done here; the rest goes to the page.
pub fn handle(window: &Window, id: &str) {
    let Some(page) = window.get_webview_window(window.label()) else { return };
    let _ = match id {
        "quit" => window.close(), // as the window's cross: asked about if there are unsaved changes
        "reload" => page.eval("location.reload()"),
        "devtools" => Ok(page.open_devtools()),
        "fullscreen" => window.is_fullscreen().and_then(|on| window.set_fullscreen(!on)),
        action => page.emit_to(window.label(), "menu", action),
    };
}
