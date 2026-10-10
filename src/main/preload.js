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
  // The atlas as a file beside the project, see atlas-file.js.
  atlas: {
    link: (project) => ipcRenderer.invoke('atlas:link', { project }),
    write: (files) => ipcRenderer.invoke('atlas:write', files),
    open: () => ipcRenderer.invoke('atlas:open'),
    reveal: () => ipcRenderer.invoke('atlas:reveal'),
    unlink: () => ipcRenderer.send('atlas:unlink'),
    onChanged: (callback) => ipcRenderer.on('atlas:changed', (_event, bytes) => callback(bytes)),
  },
});
