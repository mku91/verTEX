const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// The atlas as a file beside the project, for painting it in another program.
//
// A project "house.vertex" has "house.atlas.png" - the picture itself, which
// the painting program opens and saves - and "house.atlas.guide.png", the
// outlines of the faces, to lay over it there. The editor writes both when
// the unwrap moves something; the file is watched, and what the painter
// saves is sent to the editor (channel 'atlas:changed', the file's bytes).
//
//   atlas:link    { project } -> { path, guide, bytes?, newer }   start watching;
//                 `bytes` is the file if there is one, `newer` whether it was
//                 saved after the project was
//   atlas:write   { png?, guide? }   write what is given beside the project
//   atlas:open    open the picture in the program the system has for it
//   atlas:reveal  show the picture in the file manager
//   atlas:unlink  stop watching (a new project, one not saved yet)

function registerAtlasFile({ ipcMain, shell, BrowserWindow }) {
  const links = new WeakMap(); // window -> { picture, guide, watcher, written, timer }

  const drop = (win) => {
    const link = links.get(win);
    if (!link) return;
    link.watcher?.close();
    clearTimeout(link.timer);
    links.delete(win);
  };

  // The painter saved the picture: tell the editor, unless it is our own writing coming back.
  const changed = async (win, link) => {
    let bytes;
    try {
      bytes = await fsp.readFile(link.picture);
    } catch {
      return; // between a delete and a write: the next event has it
    }
    if (bytes.length === 0 || (link.written && bytes.equals(link.written))) return;
    link.written = bytes;
    if (!win.isDestroyed()) win.webContents.send('atlas:changed', new Uint8Array(bytes));
  };

  const watch = (win, link) => {
    link.watcher?.close();
    link.watcher = null;
    try {
      // The folder is watched, not the file: programs save by writing a new
      // file and moving it over the old one, which a watch on the file loses.
      const name = path.basename(link.picture);
      link.watcher = fs.watch(path.dirname(link.picture), (_event, file) => {
        if (file && file !== name) return;
        clearTimeout(link.timer);
        link.timer = setTimeout(() => changed(win, link), 150);
      });
    } catch {
      // No watching here (a folder that is gone): the picture is still written.
    }
  };

  ipcMain.handle('atlas:link', async (event, { project }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    drop(win);
    const base = project.replace(/\.[^.\\/]*$/, '');
    const link = { picture: `${base}.atlas.png`, guide: `${base}.atlas.guide.png`, watcher: null, written: null, timer: null };
    links.set(win, link);
    win.once('closed', () => drop(win));
    let bytes = null;
    let newer = false;
    try {
      bytes = await fsp.readFile(link.picture);
      link.written = bytes;
      const [picture, saved] = await Promise.all([fsp.stat(link.picture), fsp.stat(project)]);
      newer = picture.mtimeMs > saved.mtimeMs + 1000;
    } catch {
      // No picture beside the project yet.
    }
    watch(win, link);
    return { path: link.picture, guide: link.guide, bytes: bytes ? new Uint8Array(bytes) : null, newer };
  });

  ipcMain.handle('atlas:write', async (event, { png, guide }) => {
    const link = links.get(BrowserWindow.fromWebContents(event.sender));
    if (!link) return { error: 'the project has no file yet' };
    try {
      if (png) {
        link.written = Buffer.from(png);
        await fsp.writeFile(link.picture, link.written);
      }
      if (guide) await fsp.writeFile(link.guide, Buffer.from(guide));
      return { path: link.picture };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('atlas:open', async (event) => {
    const link = links.get(BrowserWindow.fromWebContents(event.sender));
    if (!link) return { error: 'the project has no file yet' };
    const problem = await shell.openPath(link.picture);
    return problem ? { error: problem } : { path: link.picture };
  });

  ipcMain.handle('atlas:reveal', (event) => {
    const link = links.get(BrowserWindow.fromWebContents(event.sender));
    if (link) shell.showItemInFolder(link.picture);
  });

  ipcMain.on('atlas:unlink', (event) => drop(BrowserWindow.fromWebContents(event.sender)));
}

module.exports = { registerAtlasFile };
