const fs = require('node:fs/promises');
const path = require('node:path');
const { EXTENSION, pack, unpack } = require('./project-file.js');

// The renderer's access to project files: dialogs, reading and writing.
// `ipcMain`, `dialog` and `BrowserWindow` are Electron's (passed in, so that
// the handlers can be driven without the real ones); `recent` is the list of
// the projects worked on lately (see recent.js), told of every file that is
// saved or opened.
//
//   project:save    { path, files } -> { path } | null (cancelled) | { error }
//                   Without a path the user is asked for one.
//   project:open    { path } -> { path, files } | null | { error }
//   project:confirm { name } -> 'save' | 'discard' | 'cancel'
//                   The question before unsaved changes are thrown away.
//   project:alert   { message, detail }
//   project:state   { dirty } - the window has unsaved changes or not; a
//                   window that has them asks before it closes.
//   project:close   closes the window with no more questions.
function registerProjectIo({ ipcMain, dialog, BrowserWindow, recent, t = (key) => key }) {
  const FILTERS = [{ name: t('dialog.project.filter'), extensions: [EXTENSION] }];
  const dirty = new WeakSet(); // windows with unsaved changes
  const closing = new WeakSet(); // windows told to close regardless
  const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle('project:save', async (event, { path: wanted, files }) => {
    let target = wanted;
    if (!target) {
      const result = await dialog.showSaveDialog(windowOf(event), {
        title: t('dialog.project.save.title'),
        defaultPath: `Unnamed.${EXTENSION}`,
        filters: FILTERS,
      });
      if (result.canceled || !result.filePath) return null;
      target = result.filePath;
    }
    if (path.extname(target).toLowerCase() !== `.${EXTENSION}`) target += `.${EXTENSION}`;
    try {
      // Written beside the target and moved over it, so that a failure
      // half-way leaves the previous version of the file whole.
      const temporary = `${target}.${process.pid}.tmp`;
      await fs.writeFile(temporary, pack(files));
      await fs.rename(temporary, target);
      recent?.add(target);
      return { path: target };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('project:open', async (event, { path: wanted } = {}) => {
    let source = wanted;
    if (!source) {
      const result = await dialog.showOpenDialog(windowOf(event), {
        title: t('dialog.project.open.title'),
        filters: FILTERS,
        properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths.length) return null;
      [source] = result.filePaths;
    }
    try {
      const files = unpack(await fs.readFile(source));
      recent?.add(source);
      return { path: source, files };
    } catch (error) {
      return { path: source, error: error.message };
    }
  });

  ipcMain.handle('project:confirm', async (event, { name }) => {
    const { response } = await dialog.showMessageBox(windowOf(event), {
      type: 'question',
      message: t('dialog.project.confirm.message', { name }),
      detail: t('dialog.project.confirm.detail'),
      buttons: [t('dialog.project.confirm.save'), t('dialog.project.confirm.discard'), t('dialog.project.confirm.cancel')],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return ['save', 'discard', 'cancel'][response];
  });

  ipcMain.handle('project:alert', async (event, { message, detail }) => {
    await dialog.showMessageBox(windowOf(event), { type: 'error', message, detail, buttons: [t('dialog.alert.ok')] });
  });

  ipcMain.on('project:state', (event, { dirty: unsaved }) => {
    const win = windowOf(event);
    if (!win) return;
    if (unsaved) dirty.add(win);
    else dirty.delete(win);
  });

  ipcMain.on('project:close', (event) => {
    const win = windowOf(event);
    if (!win) return;
    closing.add(win);
    win.close();
  });

  // To be called for every window: one with unsaved changes hands the closing
  // over to its page, which asks the user and then closes for good or stays.
  return function guardWindow(win) {
    win.on('close', (event) => {
      if (closing.has(win) || !dirty.has(win)) return;
      event.preventDefault();
      win.webContents.send('menu', 'project-close');
    });
  };
}

module.exports = { registerProjectIo };
