const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gunforgeNative', {
  get: (key) => ipcRenderer.invoke('store:get', key),
  set: (key, value) => ipcRenderer.invoke('store:set', key, value),
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  openReleases: () => ipcRenderer.invoke('open:releases'),
  updaterState: () => ipcRenderer.invoke('updater:state'),
  oauthListen: () => ipcRenderer.invoke('oauth:listen'),
  oauthOpen: (url) => ipcRenderer.invoke('oauth:open', url),
  oauthCancel: () => ipcRenderer.invoke('oauth:cancel'),
  onUpdater: (cb) => ipcRenderer.on('updater', (_e, msg) => cb(msg))
});
