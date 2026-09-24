const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');
const { oauthListen, isAuthUrl } = require('./oauth-loopback');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/* One game instance per machine: no multi-window match farming, no save-file write races.
   Dev/LAN testing on one machine: `npm start -- --multi` opts out. */
const multiOk = process.argv.includes('--multi');
if(!multiOk && !app.requestSingleInstanceLock()){
  app.quit();
}
app.on('second-instance', () => {
  if(win){ if(win.isMinimized()) win.restore(); win.focus(); }
});

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
/* Discord sign-in. The renderer asks for a callback address first (the authorize URL
   has to contain it), then asks us to open the URL in the player's browser and wait. */
let pendingOAuth = null;
ipcMain.handle('oauth:listen', async () => {
  if(pendingOAuth){ pendingOAuth.close(); pendingOAuth = null; }   // a second click replaces the first
  try{ pendingOAuth = await oauthListen(); return { redirect: pendingOAuth.redirect }; }
  catch(e){ return { error: 'no_port', error_description: e.message }; }
});
ipcMain.handle('oauth:open', async (e, url) => {
  const mine = pendingOAuth;
  if(!mine) return { error: 'no_listener' };
  if(!isAuthUrl(url)){ mine.close(); pendingOAuth = null; return { error: 'bad_url' }; }
  shell.openExternal(url);
  const r = await mine.result;
  if(pendingOAuth === mine) pendingOAuth = null;
  // bring the game back in front of the browser tab the player just used
  if(win){ if(win.isMinimized()) win.restore(); win.show(); win.focus(); }
  if(process.platform === 'darwin') app.focus({ steal: true });
  return r;
});
ipcMain.handle('oauth:cancel', () => { if(pendingOAuth){ pendingOAuth.close(); pendingOAuth = null; } return true; });
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
    ...(app.isPackaged ? [] : [{ role: 'viewMenu' }]), // devtools + reload for `npm start` only
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
    // Packaged builds take the icon from the bundle (electron-builder generates
    // .ico/.icns from build/). This is only so `npm start` isn't the default
    // Electron atom - build/ is not in the shipped files list.
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, 'build', 'icon.png') }),
    webPreferences: {
      backgroundThrottling: false, // live matches keep rendering/syncing when the window loses focus
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
    // slight delay dodges the load race; periodic re-checks catch releases published while playing
    setTimeout(() => { try{ autoUpdater.checkForUpdates(); }catch(e){ sendUpd({type:'error', message: e.message}); } }, 2000);
  });
  setInterval(() => { try{ autoUpdater.checkForUpdates(); }catch(e){} }, 10*60*1000);
}

/* --- auto-updater events --- */
let lastUpdaterMsg = null;
function updLog(msg){
  try{
    fs.appendFileSync(path.join(app.getPath('userData'), 'updater.log'),
      new Date().toISOString() + ' ' + JSON.stringify(msg) + '\n');
  }catch(e){}
}
function sendUpd(msg){
  lastUpdaterMsg = msg;
  updLog(msg);
  win && win.webContents.send('updater', msg);
}
// Unsigned macOS apps cannot self-install (Squirrel validates code signatures),
// so on mac we detect updates and hand the user a one-click download instead.
const canSelfUpdate = process.platform !== 'darwin';
autoUpdater.autoDownload = canSelfUpdate;
autoUpdater.autoInstallOnAppQuit = canSelfUpdate;

autoUpdater.on('checking-for-update', () => updLog({type:'checking', current: app.getVersion()}));
autoUpdater.on('update-not-available', () => updLog({type:'none', current: app.getVersion()}));
autoUpdater.on('update-available', (info) => {
  const version = info && info.version;
  sendUpd(canSelfUpdate ? { type: 'available', version } : { type: 'manual', version });
});
autoUpdater.on('download-progress', (p) => {
  sendUpd({ type: 'progress', pct: Math.round(p.percent) });
});
autoUpdater.on('update-downloaded', () => {
  sendUpd({ type: 'downloaded' });
});
autoUpdater.on('error', (e) => {
  sendUpd({ type: 'error', message: String(e && e.message || e).slice(0, 200) });
});

ipcMain.handle('updater:state', () => lastUpdaterMsg);

app.whenReady().then(() => {
  buildMenu();
  saveFile = path.join(app.getPath('userData'), 'gunforge-save.json');
  createWindow();
  app.on('activate', () => { if(BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', flushStore);
app.on('window-all-closed', () => { if(process.platform !== 'darwin') app.quit(); });
