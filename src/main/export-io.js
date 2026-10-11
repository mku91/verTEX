const fs = require('node:fs/promises');
const path = require('node:path');

// The renderer's way to write an exported model (see fbx.js and gltf.js in
// src/renderer).
// `ipcMain`, `dialog` and `BrowserWindow` are Electron's, passed in as in
// project-io.js.
//
//   export:pick   { name, kinds } -> { path, name, extension } | null (cancelled)
//                 Asks where the file is to go, and of which of the `kinds`
//                 ({ name, extension }[], the first is the usual one) it is
//                 to be. `name` back is the file's name without the
//                 extension - what goes beside it is named after that.
//   export:write  { path, bytes, beside } -> {} | { error }
//                 Writes the file, and next to it every file of `beside`
//                 ({ name: bytes }) - the texture a model refers to.
function registerExportIo({ ipcMain, dialog, BrowserWindow }) {
  const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle('export:pick', async (event, { name, kinds }) => {
    const result = await dialog.showSaveDialog(windowOf(event), {
      title: 'Экспорт',
      defaultPath: `${name}.${kinds[0].extension}`,
      filters: kinds.map((kind) => ({ name: kind.name, extensions: [kind.extension] })),
    });
    if (result.canceled || !result.filePath) return null;
    let target = result.filePath;
    const known = (file) => kinds.find((kind) => path.extname(file).toLowerCase() === `.${kind.extension}`);
    if (!known(target)) target += `.${kinds[0].extension}`;
    return { path: target, name: path.basename(target, path.extname(target)), extension: known(target).extension };
  });

  ipcMain.handle('export:write', async (_event, { path: target, bytes, beside = {} }) => {
    try {
      await fs.writeFile(target, bytes);
      for (const [name, content] of Object.entries(beside)) {
        // Beside the file and nowhere else, whatever the name says.
        await fs.writeFile(path.join(path.dirname(target), path.basename(name)), content);
      }
      return {};
    } catch (error) {
      return { error: error.message };
    }
  });
}

module.exports = { registerExportIo };
