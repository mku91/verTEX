// The interface's language: chosen in Settings, kept in the program's folder,
// English until chosen. The catalogs are src/locales/<id>.json; the page gets
// its own at the start (put in before its scripts run, see renderer/i18n.js),
// the menu takes its words from the same.

use serde_json::{Map, Value};
use std::path::PathBuf;

// Every language there is. (A new one: its catalog in src/locales and a line here.)
const CATALOGS: &[(&str, &str)] = &[
    ("en", include_str!("../../src/locales/en.json")),
    ("ru", include_str!("../../src/locales/ru.json")),
];
const FALLBACK: &str = "en";

pub struct Language {
    file: PathBuf,
    chosen: String,
    catalog: Map<String, Value>,
    fallback: Map<String, Value>,
}

fn catalog(id: &str) -> Map<String, Value> {
    CATALOGS
        .iter()
        .find(|(name, _)| *name == id)
        .and_then(|(_, text)| serde_json::from_str(text).ok())
        .unwrap_or_default()
}

impl Language {
    pub fn load(folder: PathBuf) -> Self {
        let file = folder.join("locale.json");
        let saved = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.get("locale")?.as_str().map(String::from));
        let chosen = saved.filter(|id| CATALOGS.iter().any(|(name, _)| name == id)).unwrap_or(FALLBACK.into());
        Self { file, catalog: catalog(&chosen), fallback: catalog(FALLBACK), chosen }
    }

    // The key's text; a key the language lacks is taken from English, a key no one has - as it is.
    pub fn t(&self, key: &str) -> String {
        self.catalog.get(key).or_else(|| self.fallback.get(key)).and_then(Value::as_str).unwrap_or(key).into()
    }

    // What the page is given before its scripts run (see host.js), the
    // program's version with it.
    pub fn script(&self, version: &str) -> String {
        let languages: Vec<Value> = CATALOGS
            .iter()
            .map(|(id, _)| serde_json::json!({ "id": id, "name": catalog(id).get("language.name").cloned().unwrap_or(Value::from(*id)) }))
            .collect();
        let start = serde_json::json!({ "version": version, "locale": self.chosen, "catalog": self.catalog, "fallback": self.fallback, "languages": languages });
        format!("window.__VERTEX_START__ = {start};")
    }
}

// Kept for the next start; this one goes on in its language.
#[tauri::command]
pub fn locale_set(language: tauri::State<Language>, locale: String) -> bool {
    if !CATALOGS.iter().any(|(name, _)| *name == locale) {
        return false;
    }
    if let Some(folder) = language.file.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    std::fs::write(&language.file, serde_json::json!({ "locale": locale }).to_string()).is_ok()
}
