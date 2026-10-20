const fs = require('node:fs');
const path = require('node:path');

// The interface's language: chosen in Settings, kept in the user's folder,
// English until chosen. The catalogs are src/locales/<id>.json; the page gets
// its own at the start (see renderer/i18n.js), the main process takes its
// words - the menu, the file dialogs - from the same.
const DIRECTORY = path.join(__dirname, '../locales');
const FALLBACK = 'en';

function readCatalog(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIRECTORY, `${id}.json`), 'utf8'));
  } catch {
    return {};
  }
}

function registerLocale({ ipcMain, file }) {
  const ids = fs.readdirSync(DIRECTORY).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
  let chosen = FALLBACK;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).locale;
    if (ids.includes(saved)) chosen = saved;
  } catch { /* not chosen yet */ }
  const fallback = readCatalog(FALLBACK);
  const catalog = chosen === FALLBACK ? fallback : readCatalog(chosen);
  // Every language by its own name, for the choice in Settings.
  const languages = ids.map((id) => ({ id, name: readCatalog(id)['language.name'] ?? id }));

  // Asked synchronously: the page's words must be there before its scripts run.
  ipcMain.on('locale:get', (event) => {
    event.returnValue = { locale: chosen, catalog, fallback, languages };
  });
  // Kept for the next start; this one goes on in its language.
  ipcMain.handle('locale:set', (_event, { locale }) => {
    if (!ids.includes(locale)) return false;
    fs.writeFileSync(file, JSON.stringify({ locale }));
    return true;
  });

  return function t(key, params) {
    const text = catalog[key] ?? fallback[key] ?? key;
    return params ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole)) : text;
  };
}

module.exports = { registerLocale };
