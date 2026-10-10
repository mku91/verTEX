const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vertex', {
  onMenu: (callback) => ipcRenderer.on('menu', (_event, action) => callback(action)),
  // Project files, see project-io.js for what each call takes and gives.
  project: {
    save: (path, files) => ipcRenderer.invoke('project:save', { path, files }),
    open: (path) => ipcRenderer.invoke('project:open', { path }),
    confirm: (name) => ipcRenderer.invoke('project:confirm', { name }),
    alert: (message, detail) => ipcRenderer.invoke('project:alert', { message, detail }),
    setState: (state) => ipcRenderer.send('project:state', state),
    close: () => ipcRenderer.send('project:close'),
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
