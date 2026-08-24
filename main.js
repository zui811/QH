const { app, BrowserWindow, ipcMain, dialog, screen, Tray, Menu } = require('electron');
const path = require('path');
const MIN_WINDOW_WIDTH = 220;
const MIN_WINDOW_HEIGHT = 260;

let win;
let tray;

function showWindow() {
  if (!win) return;
  win.show();
  win.restore();
  win.focus();
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'app-icon.ico'));
  tray.setToolTip('千幻桌面便笺');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示便笺', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', showWindow);
}

function loginOptions(openAtLogin) {
  const portablePath = process.env.PORTABLE_EXECUTABLE_FILE;
  return {
    openAtLogin,
    path: portablePath || process.execPath,
    args: portablePath || app.isPackaged ? [] : [path.resolve(__dirname)]
  };
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: area.x + area.width - 430,
    y: area.y + 56,
    width: 390,
    height: Math.min(720, area.height - 100),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(false);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  ipcMain.handle('choose-background', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.on('window-action', (_event, action) => {
    if (!win) return;
    if (action === 'close') app.quit();
    if (action === 'minimize') win.hide();
    if (action === 'toggle-top') win.setAlwaysOnTop(!win.isAlwaysOnTop());
  });
  ipcMain.handle('is-always-on-top', () => win?.isAlwaysOnTop() ?? false);
  ipcMain.handle('is-devtools-opened', () => win?.webContents.isDevToolsOpened() ?? false);
  ipcMain.handle('get-auto-launch', () => app.getLoginItemSettings(loginOptions(false)).openAtLogin);
  ipcMain.handle('set-auto-launch', (_event, enabled) => {
    app.setLoginItemSettings(loginOptions(Boolean(enabled)));
    return app.getLoginItemSettings(loginOptions(Boolean(enabled))).openAtLogin;
  });
  ipcMain.on('resize-window', (_event, width, height) => {
    if (!win) return;
    const bounds = win.getBounds();
    win.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: Math.max(MIN_WINDOW_WIDTH, Math.round(width)),
      height: Math.max(MIN_WINDOW_HEIGHT, Math.round(height))
    }, false);
  });
  createWindow();
  createTray();
});

app.on('window-all-closed', () => app.quit());
