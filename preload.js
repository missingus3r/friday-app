const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('friday', {
  api: (req) => ipcRenderer.invoke('api', req),
  getConfig: () => ipcRenderer.invoke('cfg:get'),
  activate: (token, base) => ipcRenderer.invoke('activate', { token, base }),
  deactivate: () => ipcRenderer.invoke('deactivate'),
  liveUrl: () => ipcRenderer.invoke('live:url'),
});
