const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gunforgeNative', {
  get: (key) => ipcRenderer.invoke('store:get', key),
  set: (key, value) => ipcRenderer.invoke('store:set', key, value),
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  onUpdater: (cb) => ipcRenderer.on('updater', (_e, msg) => cb(msg))
});
