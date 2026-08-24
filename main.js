const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');

let win;

function loginOptions(openAtLogin) {
  const portablePath = process.env.PORTABLE_EXECUTABLE_FILE;
  return {
    openAtLogin,
    path: portablePath || process.execPath,
    args: portablePath ? [] : [path.resolve(__dirname)]
  };
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: area.x + area.width - 430,
    y: area.y + 56,
    width: 390,
    height: Math.min(720, area.height - 100),
    minWidth: 330,
    minHeight: 420,
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
    if (action === 'minimize') win.minimize();
    if (action === 'toggle-top') win.setAlwaysOnTop(!win.isAlwaysOnTop());
  });
  ipcMain.handle('is-always-on-top', () => win?.isAlwaysOnTop() ?? false);
  ipcMain.handle('set-auto-launch', (_event, enabled) => {
    app.setLoginItemSettings(loginOptions(Boolean(enabled)));
    return app.getLoginItemSettings(loginOptions(Boolean(enabled))).openAtLogin;
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
