const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  chooseBackground: () => ipcRenderer.invoke('choose-background'),
  windowAction: action => ipcRenderer.send('window-action', action),
  isAlwaysOnTop: () => ipcRenderer.invoke('is-always-on-top'),
  isDevToolsOpened: () => ipcRenderer.invoke('is-devtools-opened'),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: enabled => ipcRenderer.invoke('set-auto-launch', enabled),
  resizeWindow: (width, height) => ipcRenderer.send('resize-window', width, height)
});
