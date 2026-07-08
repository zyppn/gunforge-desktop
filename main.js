const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let saveFile = null;
let data = null;
let writeT = null;

function loadStore(){
  if(data) return data;
  try{ data = JSON.parse(fs.readFileSync(saveFile, 'utf8')); }
  catch(e){ data = {}; }
  return data;
}
function flushStore(){
  try{ fs.writeFileSync(saveFile, JSON.stringify(loadStore())); }catch(e){}
}
function scheduleWrite(){
  clearTimeout(writeT);
  writeT = setTimeout(flushStore, 150);
}

ipcMain.handle('win:fullscreen', (e, on) => {
  if(win) win.setFullScreen(!!on);
  return true;
});
ipcMain.handle('store:get', (e, key) => {
  const d = loadStore();
  return key in d ? d[key] : null;
});
ipcMain.handle('store:set', (e, key, value) => {
  loadStore()[key] = value;
  scheduleWrite();
  return true;
});

function createWindow(){
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0D1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    autoUpdater.checkForUpdates();
  });
}

/* --- auto-updater events --- */
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', () => {
  win && win.webContents.send('updater', { type: 'available' });
});
autoUpdater.on('download-progress', (p) => {
  win && win.webContents.send('updater', { type: 'progress', pct: Math.round(p.percent) });
});
autoUpdater.on('update-downloaded', () => {
  win && win.webContents.send('updater', { type: 'downloaded' });
});
autoUpdater.on('error', (e) => {
  console.error('updater error', e.message);
});

app.whenReady().then(() => {
  saveFile = path.join(app.getPath('userData'), 'gunforge-save.json');
  createWindow();
  app.on('activate', () => { if(BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', flushStore);
app.on('window-all-closed', () => { if(process.platform !== 'darwin') app.quit(); });
