const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vertex', {
  onMenu: (callback) => ipcRenderer.on('menu', (_event, action) => callback(action)),
  // The window as the editor wants it (maximized, with its menu bar), or as
  // the welcome screen does (no menu bar).
  editing: (on) => ipcRenderer.send('window:editor', on),
  // Project files, see project-io.js for what each call takes and gives.
  project: {
    save: (path, files) => ipcRenderer.invoke('project:save', { path, files }),
    open: (path) => ipcRenderer.invoke('project:open', { path }),
    confirm: (name) => ipcRenderer.invoke('project:confirm', { name }),
    alert: (message, detail) => ipcRenderer.invoke('project:alert', { message, detail }),
    setState: (state) => ipcRenderer.send('project:state', state),
    close: () => ipcRenderer.send('project:close'),
  },
  // Writing an exported model, see export-io.js.
  export: {
    pick: (name, kinds) => ipcRenderer.invoke('export:pick', { name, kinds }),
    write: (path, bytes, beside) => ipcRenderer.invoke('export:write', { path, bytes, beside }),
  },
  // The projects worked on lately, see recent.js.
  recent: {
    list: () => ipcRenderer.invoke('recent:list'),
    remove: (path) => ipcRenderer.invoke('recent:remove', { path }),
  },
  // The atlas as working files on disk, see atlas-file.js.
  atlas: {
    link: (project) => ipcRenderer.invoke('atlas:link', { project }),
    write: (files) => ipcRenderer.invoke('atlas:write', files),
    discard: () => ipcRenderer.invoke('atlas:discard'),
    open: (program) => ipcRenderer.invoke('atlas:open', { program }),
    pickProgram: () => ipcRenderer.invoke('atlas:pick-program'),
    reveal: () => ipcRenderer.invoke('atlas:reveal'),
    unlink: () => ipcRenderer.send('atlas:unlink'),
    onChanged: (callback) => ipcRenderer.on('atlas:changed', (_event, bytes) => callback(bytes)),
  },
});
