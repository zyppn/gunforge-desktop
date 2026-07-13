const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
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

ipcMain.handle('open:releases', () => {
  shell.openExternal('https://github.com/zyppn/gunforge-desktop/releases/latest');
  return true;
});
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

function buildMenu(){
  // no View menu = no Cmd+/Cmd- zoom or Cmd+R reload accelerators; edit/window shortcuts kept
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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
  win.webContents.setVisualZoomLevelLimits(1, 1); // no pinch zoom
  win.webContents.on('before-input-event', (e, input) => {
    // swallow browser-zoom chords even if a future menu reintroduces them
    if((input.control || input.meta) && ['=', '+', '-', '_', '0'].includes(input.key)) e.preventDefault();
  });
  win.webContents.on('did-finish-load', () => { try{ win.webContents.setZoomFactor(1); }catch(e){} });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    autoUpdater.checkForUpdates();
  });
}

/* --- auto-updater events --- */
// Unsigned macOS apps cannot self-install (Squirrel validates code signatures),
// so on mac we detect updates and hand the user a one-click download instead.
const canSelfUpdate = process.platform !== 'darwin';
autoUpdater.autoDownload = canSelfUpdate;
autoUpdater.autoInstallOnAppQuit = canSelfUpdate;

autoUpdater.on('update-available', (info) => {
  const version = info && info.version;
  win && win.webContents.send('updater', canSelfUpdate
    ? { type: 'available', version }
    : { type: 'manual', version });
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
  buildMenu();
  saveFile = path.join(app.getPath('userData'), 'gunforge-save.json');
  createWindow();
  app.on('activate', () => { if(BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', flushStore);
app.on('window-all-closed', () => { if(process.platform !== 'darwin') app.quit(); });
