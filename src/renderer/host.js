// The page's way to the computer, window.vertex: files, folders, the window,
// other programs. In Tauri it is made here, of the window's commands (see
// src-tauri) - app.js imports this module first, so it is there before
// anything asks.
//
// What the program knows at the start - the interface's language and its
// words - it put into the page before its scripts ran, as
// window.__VERTEX_START__: the words are wanted at once, before anything is
// shown.

import { EXTENSION, pack, unpack, preview } from './project-file.js';
import { atlasFiles } from './atlas-files.js';

const tauri = window.__TAURI__;

if (tauri) {
  const { invoke } = tauri.core;
  const { listen } = tauri.event;
  const start = window.__VERTEX_START__;
  // (The page's own t() is not there yet: it is built on what this module gives.)
  const word = (key) => start.catalog[key] ?? start.fallback[key] ?? key;

  // --- files ----------------------------------------------------------------
  // A command that fails rejects with its message; a file that is not there
  // with 'missing'.
  const read = async (path) => new Uint8Array(await invoke('file_read', { path }));
  const write = (path, bytes) => invoke('file_write', bytes, { headers: { path: encodeURIComponent(path) } });
  const message = (error) => (typeof error === 'string' ? error : error?.message ?? String(error));
  const baseName = (path) => path.split(/[\\/]/).pop();
  const folderOf = (path) => path.slice(0, path.length - baseName(path).length);
  const extensionOf = (path) => /\.[^.\\/]*$/.exec(path)?.[0].toLowerCase() ?? '';
  // The same file whatever way its path was written (Windows: in any case, with either slash).
  const keyOf = (path) => path.replaceAll('/', '\\').toLowerCase();

  // --- the projects worked on lately -----------------------------------------
  // For the welcome screen: a list of their files, the latest first, kept
  // between launches in the program's own folder (recent.json) - not in the
  // projects, which do not know of it.
  //
  // A file gets to the top of the list when it is opened and when it is
  // saved. One that is no longer where it was stays in the list, marked: the
  // disk it is on may only be unplugged. The user takes it out.
  const RECENT = 'recent.json';
  const RECENT_LIMIT = 24; // the files remembered
  let entries = null; // [{ path, opened }], read when first asked for
  let writing = Promise.resolve();
  const readRecent = async () => {
    if (entries) return entries;
    try {
      const saved = JSON.parse(await invoke('data_read', { name: RECENT }) ?? '[]');
      entries = saved.filter((entry) => typeof entry?.path === 'string' && Number.isFinite(entry.opened));
    } catch {
      entries = []; // an unreadable list
    }
    return entries;
  };
  // One writing after another, so that two in a row cannot leave half a file.
  const writeRecent = () => {
    const text = JSON.stringify(entries, null, 1);
    writing = writing.then(() => invoke('data_write', { name: RECENT, text })).catch(() => {}); // a convenience: a failure stops nothing
    return writing;
  };
  const without = (list, project) => list.filter((entry) => keyOf(entry.path) !== keyOf(project));
  const remember = async (project) => {
    entries = [{ path: project, opened: Date.now() }, ...without(await readRecent(), project)].slice(0, RECENT_LIMIT);
    await writeRecent();
  };

  // --- project files -----------------------------------------------------------
  const FILTERS = [{ name: word('dialog.project.filter'), extensions: [EXTENSION] }];

  async function saveProject(wanted, files) {
    let target = wanted;
    if (!target) {
      target = await invoke('ask_save', { ask: { title: word('dialog.project.save.title'), filters: FILTERS, defaultName: `Unnamed.${EXTENSION}` } });
      if (!target) return null;
    }
    if (extensionOf(target) !== `.${EXTENSION}`) target += `.${EXTENSION}`;
    try {
      await write(target, pack(files));
      remember(target);
      return { path: target };
    } catch (error) {
      return { error: message(error) };
    }
  }

  async function openProject(wanted) {
    let source = wanted;
    if (!source) {
      source = await invoke('ask_open', { ask: { title: word('dialog.project.open.title'), filters: FILTERS } });
      if (!source) return null;
    }
    try {
      const files = unpack(await read(source));
      remember(source);
      return { path: source, files };
    } catch (error) {
      return { path: source, error: message(error) };
    }
  }

  // --- exported files -------------------------------------------------------------
  // Where an exported file is to go, and of which of the `kinds`
  // ({ name, extension }[], the first is the usual one) it is to be. `name`
  // back is the file's name without the extension - what goes beside it is
  // named after that.
  async function pickExport(name, kinds) {
    let target = await invoke('ask_save', {
      ask: { title: word('dialog.export.title'), filters: kinds.map((kind) => ({ name: kind.name, extensions: [kind.extension] })), defaultName: `${name}.${kinds[0].extension}` },
    });
    if (!target) return null;
    const known = (file) => kinds.find((kind) => extensionOf(file) === `.${kind.extension}`);
    if (!known(target)) target += `.${kinds[0].extension}`;
    const file = baseName(target);
    return { path: target, name: file.slice(0, file.length - extensionOf(file).length), extension: known(target).extension };
  }

  // Writes the file, and next to it every file of `beside` ({ name: bytes }) -
  // the texture a model refers to.
  async function writeExport(target, bytes, beside = {}) {
    try {
      await write(target, bytes);
      for (const [name, content] of Object.entries(beside)) {
        // Beside the file and nowhere else, whatever the name says.
        await write(folderOf(target) + baseName(name), content);
      }
      return {};
    } catch (error) {
      return { error: message(error) };
    }
  }

  // The atlases' working files, for painting them in another program.
  const atlas = atlasFiles({ invoke, listen, word });

  window.vertex = {
    // The program's version (from package.json, see src-tauri/tauri.conf.json).
    version: start.version,
    locale: {
      get: () => start,
      set: (locale) => invoke('locale_set', { locale }),
    },
    onMenu: (callback) => listen('menu', (event) => callback(event.payload)),
    // A newer version of the program (see src-tauri/src/update.rs): check()
    // gives { version, notes } or null; install() takes it, telling
    // onProgress(bytes, total or null) how far it has got - and the program
    // starts anew, updated.
    updates: {
      check: () => invoke('update_check'),
      install: async (onProgress) => {
        const stop = await listen('update-progress', (event) => onProgress(...event.payload));
        try {
          await invoke('update_install');
        } finally {
          stop();
        }
      },
    },
    // The window as the editor wants it (maximized, with its menu bar), or as
    // the welcome screen does (no menu bar).
    editing: (on) => invoke('window_editing', { on }),
    // (Asking and telling are the page's own dialogs, see app.js.)
    project: {
      save: saveProject,
      open: openProject,
      setState: ({ dirty }) => invoke('project_state', { dirty }),
      close: () => invoke('window_close'),
    },
    export: { pick: pickExport, write: writeExport },
    recent: {
      // [{ path, name, opened, missing, preview }], the latest first;
      // `preview` is the picture inside the project file (PNG bytes), or null.
      list: async () => Promise.all((await readRecent()).map(async (entry) => {
        const file = baseName(entry.path);
        const shown = { path: entry.path, name: file.replace(/\.[^.]*$/, ''), opened: entry.opened, missing: false, preview: null };
        try {
          shown.preview = preview(await read(entry.path));
        } catch (error) {
          // Not there; a file that is there and cannot be read is shown without a picture.
          shown.missing = error === 'missing';
        }
        return shown;
      })),
      remove: async (project) => {
        entries = without(await readRecent(), project);
        await writeRecent();
      },
      // The project thrown away: its file into the Recycle Bin, its atlases'
      // working files after it, and it out of the list. -> {} | { error }
      trash: async (project) => {
        try {
          await invoke('path_trash', { path: project });
        } catch (error) {
          return { error: message(error) };
        }
        await atlas.forget(project).catch(() => {});
        entries = without(await readRecent(), project);
        await writeRecent();
        return {};
      },
    },
    atlas,
  };
}
