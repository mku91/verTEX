const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vertex', {
  onMenu: (callback) => ipcRenderer.on('menu', (_event, action) => callback(action)),
});
