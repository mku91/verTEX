const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// The atlases as files on disk, for painting them in another program.
//
// A project file holds its atlases inside it, and a painting program cannot
// open a picture that is inside an archive. So while a project is open its
// atlases are also kept as working files, in a folder of the project's own
// in the system's temporary directory - not beside the project, which stays
// one file:
//
//   <tmp>/verTEX/<a name made of the project's path>/
//     house.atlas.png              the atlas main's picture, which the painter opens and saves
//     house.atlas.guide.png        the outlines of its faces, to lay over it there
//     house.<id>.atlas.png         another atlas' (a project with several: see
//     house.<id>.atlas.guide.png   Editor.atlases), by its id
//     project.json                 { project } - whose folder this is
//
// The editor writes them when the unwrap moves something; the pictures are
// watched, and what the painter saves is sent to the editor (channel
// 'atlas:changed', the file's bytes and its atlas' id).
//
// The folders are not left to pile up. One is removed when its project moves
// to another file, and all of them are gone through when the program starts
// (see sweep()): a folder is removed if its project is no longer there, if
// its picture is no newer than the project file - then the project has all
// of it - or if nothing in it has been touched for a long time. A picture
// that is newer than its project is kept: it is work that was painted and
// not saved into the project yet, and the project takes it when it is opened.
//
//   atlas:link    { project, atlases (ids) } -> { folder, pictures: [{ atlas,
//                 path, bytes?, newer }] }   start watching; `bytes` is an
//                 atlas' picture if there is one, `newer` whether it was saved
//                 after the project was
//   atlas:write   { atlas, png?, guide? }   write what is given, of that atlas
//   atlas:discard the unsaved changes were thrown away: so are the pictures
//   atlas:open    { program?, atlas } open an atlas' picture: in the given
//                 program (the path of its executable - the user's external
//                 editor), or in the one the system has for such files
//   atlas:pick-program   ask for a program's file -> its path, or null
//   atlas:reveal  { atlas } show an atlas' picture in the file manager
//   atlas:unlink  stop watching (a new project, one not saved yet)

const HOME = path.join(os.tmpdir(), 'verTEX');
const MAIN = 'main'; // the atlas whose files have no id in their names (a project's one, as it always was)
const PICTURE = '.atlas.png';
const GUIDE = '.atlas.guide.png';
// An atlas' working files in a project's folder (`base`: the project's name).
const pictureName = (base, atlas) => (atlas === MAIN ? `${base}${PICTURE}` : `${base}.${atlas}${PICTURE}`);
const guideName = (base, atlas) => (atlas === MAIN ? `${base}${GUIDE}` : `${base}.${atlas}${GUIDE}`);
// The atlas a picture's file is of; null for none of them (a guide, or another file).
function atlasOfFile(base, file) {
  if (!file.endsWith(PICTURE) || file.endsWith(GUIDE)) return null;
  if (file === `${base}${PICTURE}`) return MAIN;
  const middle = file.slice(0, -PICTURE.length);
  return middle.startsWith(`${base}.`) ? middle.slice(base.length + 1) || null : null;
}
const sound = (atlas) => typeof atlas === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(atlas);
const STALE_AFTER = 30 * 24 * 60 * 60 * 1000; // ms a folder may lie untouched

// The working folder of a project file: named by the file's path, so that the
// same project finds its folder again and two projects never share one.
function folderOf(project) {
  const full = path.resolve(project);
  const key = crypto.createHash('sha1').update(process.platform === 'win32' ? full.toLowerCase() : full).digest('hex').slice(0, 12);
  const name = path.basename(full).replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'project';
  return path.join(HOME, `${name}-${key}`);
}

const remove = (target) => fsp.rm(target, { recursive: true, force: true }).catch(() => {});
const modified = async (file) => {
  try {
    return (await fsp.stat(file)).mtimeMs;
  } catch {
    return null;
  }
};

// Goes through the working folders and removes those that are of no use any
// more (see the note above). `keep` are folders in use, left alone. Returns
// the folders removed.
async function sweep(keep = new Set(), home = HOME) {
  let names;
  try {
    names = await fsp.readdir(home);
  } catch {
    return []; // no folders yet
  }
  const now = Date.now();
  const gone = [];
  await Promise.all(names.map(async (name) => {
    const folder = path.join(home, name);
    if (keep.has(folder)) return;
    let project = null;
    try {
      project = JSON.parse(await fsp.readFile(path.join(folder, 'project.json'), 'utf8')).project;
    } catch {
      // A folder that does not say whose it is: nobody's.
    }
    const saved = project ? await modified(project) : null;
    const files = await fsp.readdir(folder).catch(() => []);
    const times = (await Promise.all(files.map((file) => modified(path.join(folder, file))))).filter((time) => time !== null);
    // (the newest of the atlases' pictures)
    const pictures = (await Promise.all(files.filter((file) => file.endsWith(PICTURE) && !file.endsWith(GUIDE)).map((file) => modified(path.join(folder, file))))).filter((time) => time !== null);
    const picture = pictures.length ? Math.max(...pictures) : null;
    const useless =
      saved === null || // the project is gone
      picture === null || picture <= saved + 1000 || // nothing painted since the project was saved: it has it all
      now - Math.max(0, ...times) > STALE_AFTER;
    if (!useless) return;
    await remove(folder);
    gone.push(folder);
  }));
  return gone;
}

function registerAtlasFile({ ipcMain, shell, dialog, BrowserWindow }) {
  const links = new WeakMap(); // window -> { folder, base, written (atlas id -> bytes), watcher, timers }
  const inUse = new Set(); // the folders of the windows' projects

  sweep(inUse);

  // Stops watching. With `clear`, the folder goes too: its project has moved
  // to another file, and has taken what was in it along.
  const drop = (win, clear = false) => {
    const link = links.get(win);
    if (!link) return;
    link.watcher?.close();
    for (const timer of link.timers.values()) clearTimeout(timer);
    links.delete(win);
    inUse.delete(link.folder);
    if (clear) remove(link.folder);
  };

  // The painter saved an atlas' picture: tell the editor, unless it is our own writing coming back.
  const changed = async (win, link, atlas) => {
    let bytes;
    try {
      bytes = await fsp.readFile(path.join(link.folder, pictureName(link.base, atlas)));
    } catch {
      return; // between a delete and a write: the next event has it
    }
    const written = link.written.get(atlas);
    if (bytes.length === 0 || (written && bytes.equals(written))) return;
    link.written.set(atlas, bytes);
    if (!win.isDestroyed()) win.webContents.send('atlas:changed', new Uint8Array(bytes), atlas);
  };

  const watch = (win, link) => {
    link.watcher?.close();
    link.watcher = null;
    try {
      // The folder is watched, not the files: programs save by writing a new
      // file and moving it over the old one, which a watch on the file loses.
      // Which atlas' picture it was, its name says.
      link.watcher = fs.watch(link.folder, (_event, file) => {
        const atlas = file ? atlasOfFile(link.base, file) : null;
        if (!atlas) return;
        clearTimeout(link.timers.get(atlas));
        link.timers.set(atlas, setTimeout(() => changed(win, link, atlas), 150));
      });
    } catch {
      // No watching here: the picture is still written.
    }
  };

  ipcMain.handle('atlas:link', async (event, { project, atlases = [MAIN] }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const folder = folderOf(project);
    // Another project than before: the old one's folder has had its day.
    const old = links.get(win);
    drop(win, Boolean(old) && old.folder !== folder);
    const base = path.basename(project).replace(/\.[^.]*$/, '');
    const link = { folder, base, written: new Map(), watcher: null, timers: new Map() };
    links.set(win, link);
    inUse.add(folder);
    win.once('closed', () => drop(win));
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, 'project.json'), JSON.stringify({ project: path.resolve(project) }));

    // Working files from when they were kept beside the project move in here,
    // if they are the newer ones, and are cleared away from there. (The one
    // atlas there was then: main.)
    const beside = project.replace(/\.[^.\\/]*$/, '');
    const legacy = { picture: `${beside}${PICTURE}`, guide: `${beside}${GUIDE}` };
    const mainPicture = path.join(folder, pictureName(base, MAIN));
    const [there, here] = await Promise.all([modified(legacy.picture), modified(mainPicture)]);
    if (there !== null) {
      if (here === null || there > here) await fsp.copyFile(legacy.picture, mainPicture).catch(() => {});
      await Promise.all([remove(legacy.picture), remove(legacy.guide)]);
    }

    const saved = await modified(project);
    const pictures = await Promise.all(atlases.filter(sound).map(async (atlas) => {
      const file = path.join(folder, pictureName(base, atlas));
      let bytes = null;
      let newer = false;
      try {
        bytes = await fsp.readFile(file);
        link.written.set(atlas, bytes);
        // (A copy is as new as the moment it was made: the picture brought in
        // from beside the project is judged by the time it had there.)
        const painted = atlas === MAIN && there !== null && (here === null || there > here) ? there : (await fsp.stat(file)).mtimeMs;
        newer = saved !== null && painted > saved + 1000;
      } catch {
        // No picture yet.
      }
      return { atlas, path: file, bytes: bytes ? new Uint8Array(bytes) : null, newer };
    }));
    watch(win, link);
    return { folder, pictures };
  });

  ipcMain.handle('atlas:write', async (event, { atlas = MAIN, png, guide }) => {
    const link = links.get(BrowserWindow.fromWebContents(event.sender));
    if (!link) return { error: 'the project has no file yet' };
    if (!sound(atlas)) return { error: 'no such atlas' };
    const picture = path.join(link.folder, pictureName(link.base, atlas));
    try {
      await fsp.mkdir(link.folder, { recursive: true }); // (a cleaner may have been by)
      if (png) {
        link.written.set(atlas, Buffer.from(png));
        await fsp.writeFile(picture, link.written.get(atlas));
      }
      if (guide) await fsp.writeFile(path.join(link.folder, guideName(link.base, atlas)), Buffer.from(guide));
      return { path: picture };
    } catch (error) {
      return { error: error.message };
    }
  });

  // The project's unsaved changes were thrown away - what was painted and not
  // saved among them: the pictures must not come back as "newer" next time.
  ipcMain.handle('atlas:discard', async (event) => {
    const link = links.get(BrowserWindow.fromWebContents(event.sender));
    if (!link) return;
    link.written.clear();
    const files = await fsp.readdir(link.folder).catch(() => []);
    await Promise.all(files.filter((file) => file.endsWith(PICTURE) || file.endsWith(GUIDE)).map((file) => remove(path.join(link.folder, file))));
  });

  ipcMain.handle('atlas:open', async (event, { program, atlas = MAIN } = {}) => {
    const link = links.get(BrowserWindow.fromWebContents(event.sender));
    if (!link) return { error: 'the project has no file yet' };
    if (!sound(atlas)) return { error: 'no such atlas' };
    const picture = path.join(link.folder, pictureName(link.base, atlas));
    if (!program) {
      const problem = await shell.openPath(picture);
      return problem ? { error: problem } : { path: picture };
    }
    // The user's editor, started on its own: it outlives this window, and
    // what it prints is nobody's to read.
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(program, [picture], { detached: true, stdio: 'ignore' });
      } catch (error) {
        resolve({ error: error.message });
        return;
      }
      child.once('error', (error) => resolve({ error: error.message }));
      child.once('spawn', () => {
        child.unref();
        resolve({ path: picture });
      });
    });
  });

  ipcMain.handle('atlas:pick-program', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Программа для рисования',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Программы', extensions: ['exe'] }, { name: 'Все файлы', extensions: ['*'] }]
        : [{ name: 'Все файлы', extensions: ['*'] }],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  ipcMain.handle('atlas:reveal', (event, { atlas = MAIN } = {}) => {
    const link = links.get(BrowserWindow.fromWebContents(event.sender));
    if (link && sound(atlas)) shell.showItemInFolder(path.join(link.folder, pictureName(link.base, atlas)));
  });

  ipcMain.on('atlas:unlink', (event) => drop(BrowserWindow.fromWebContents(event.sender)));
}

module.exports = { registerAtlasFile, sweep, folderOf, HOME, atlasOfFile, pictureName };
