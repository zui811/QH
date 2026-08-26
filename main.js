const { app, BrowserWindow, ipcMain, dialog, screen, Tray, Menu, clipboard, globalShortcut, nativeImage, shell, Notification } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initLogger, log, getLogDirectory } = require('./logger');
const { DEFAULT_REMINDER_MINUTES, normalizeReminderMinutes, normalizeReminderTasks, reminderKey, collectDueReminders } = require('./reminders');

const MIN_WINDOW_WIDTH = 220;
const MIN_WINDOW_HEIGHT = 260;
const MAX_CLIPBOARD_ITEM_BYTES = 20 * 1024 * 1024;
const MAX_CLIPBOARD_TOTAL_BYTES = 100 * 1024 * 1024;
const VALID_CLIPBOARD_TYPES = new Set(['text', 'rich', 'image', 'files']);
const DEFAULT_CLIPBOARD_SETTINGS = {
  paused: false,
  maxItems: 100,
  expireDays: 30,
  persistHistory: true,
  excludedApps: ['1password', 'bitwarden', 'keepass', 'keepassxc'],
  openShortcut: 'CommandOrControl+Shift+V',
  directPaste: true
};

let win;
let tray;
let clipboardTimer;
let taskReminderTimer;
let taskReminders = [];
let taskRemindersEnabled = true;
let taskReminderMinutes = DEFAULT_REMINDER_MINUTES;
let notifiedTaskKeys = new Set();
const activeTaskNotifications = new Set();
let captureBusy = false;
let lastClipboardHash = '';
let pickerTargetHandle = '';
let clipboardItems = [];
let clipboardSettings = { ...DEFAULT_CLIPBOARD_SETTINGS };
let shortcutStatus = { open: false, direct: [] };

const preferredLogDirectory = app.isPackaged
  ? path.join(path.dirname(process.execPath), 'dist', 'logs')
  : path.join(__dirname, 'dist', 'logs');
const fallbackLogDirectory = path.join(app.getPath('userData'), 'logs');
const activeLogDirectory = initLogger(preferredLogDirectory, fallbackLogDirectory);
const logLocation = activeLogDirectory && path.resolve(activeLogDirectory) === path.resolve(preferredLogDirectory) ? 'application' : 'fallback';
log('main', 'info', 'Application process started', { version: app.getVersion(), platform: process.platform, arch: process.arch, logLocation });
process.on('uncaughtException', error => {
  log('main', 'error', 'Uncaught exception', error);
  setImmediate(() => app.quit());
});
process.on('unhandledRejection', reason => log('main', 'error', 'Unhandled rejection', reason instanceof Error ? reason : { reason: String(reason) }));

const historyPath = () => path.join(app.getPath('userData'), 'clipboard-history.json');
const settingsPath = () => path.join(app.getPath('userData'), 'clipboard-settings.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clampInteger = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
};
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  const backup = `${file}.bak`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), 'utf8');
    fs.rmSync(backup, { force: true });
    if (fs.existsSync(file)) fs.renameSync(file, backup);
    fs.renameSync(temporary, file);
    fs.rmSync(backup, { force: true });
    return true;
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    try { if (!fs.existsSync(file) && fs.existsSync(backup)) fs.renameSync(backup, file); } catch {}
    return false;
  }
}
function notifyPersistenceError(message) {
  log('main', 'error', 'Persistence operation failed', { message });
  if (win && !win.isDestroyed()) win.webContents.send('persistence-error', message);
}
function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    paused: Boolean(value.paused),
    maxItems: clampInteger(value.maxItems, 10, 1000, DEFAULT_CLIPBOARD_SETTINGS.maxItems),
    expireDays: clampInteger(value.expireDays, 0, 3650, DEFAULT_CLIPBOARD_SETTINGS.expireDays),
    persistHistory: value.persistHistory !== false,
    excludedApps: Array.isArray(value.excludedApps)
      ? value.excludedApps.map(item => String(item).trim().toLowerCase()).filter(Boolean).slice(0, 100)
      : [...DEFAULT_CLIPBOARD_SETTINGS.excludedApps],
    openShortcut: typeof value.openShortcut === 'string' && value.openShortcut.trim()
      ? value.openShortcut.trim().slice(0, 80)
      : DEFAULT_CLIPBOARD_SETTINGS.openShortcut,
    directPaste: value.directPaste !== false
  };
}
function estimateItemBytes(item) {
  let bytes = Buffer.byteLength(item.text || '', 'utf8') + Buffer.byteLength(item.html || '', 'utf8');
  bytes += Math.floor((item.imageData || '').length * 0.75);
  bytes += Math.floor((item.fileData || '').length * 0.75);
  bytes += Buffer.byteLength(JSON.stringify(item.filePaths || []), 'utf8');
  return bytes;
}
function normalizeClipboardItem(item) {
  if (!item || typeof item !== 'object' || !VALID_CLIPBOARD_TYPES.has(item.type)) return null;
  const createdAt = Number(item.createdAt);
  const normalized = {
    id: typeof item.id === 'string' && item.id ? item.id : `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: item.type,
    text: typeof item.text === 'string' ? item.text : '',
    html: typeof item.html === 'string' ? item.html : '',
    imageData: typeof item.imageData === 'string' ? item.imageData : '',
    fileData: typeof item.fileData === 'string' ? item.fileData : '',
    filePaths: Array.isArray(item.filePaths) ? item.filePaths.map(String).filter(Boolean).slice(0, 500) : [],
    source: typeof item.source === 'string' && item.source ? item.source.slice(0, 120) : '未知应用',
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
    pinned: Boolean(item.pinned),
    hash: typeof item.hash === 'string' && item.hash ? item.hash : ''
  };
  if (estimateItemBytes(normalized) > MAX_CLIPBOARD_ITEM_BYTES) return null;
  if (!normalized.hash) normalized.hash = hash(`${normalized.type}\0${normalized.imageData || normalized.fileData || normalized.text}\0${normalized.html}\0${JSON.stringify(normalized.filePaths)}`);
  return normalized;
}
function normalizeClipboardItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeClipboardItem).filter(Boolean);
}
function pruneClipboard() {
  const cutoff = clipboardSettings.expireDays > 0 ? Date.now() - clipboardSettings.expireDays * 86400000 : 0;
  const candidates = clipboardItems
    .filter(item => item.pinned || !cutoff || item.createdAt >= cutoff)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);
  const kept = [];
  let totalBytes = 0;
  for (const item of candidates) {
    const bytes = estimateItemBytes(item);
    if (kept.length >= clipboardSettings.maxItems || totalBytes + bytes > MAX_CLIPBOARD_TOTAL_BYTES) continue;
    kept.push(item);
    totalBytes += bytes;
  }
  clipboardItems = kept;
}
function loadClipboardData() {
  clipboardSettings = normalizeSettings(readJson(settingsPath(), {}));
  clipboardItems = clipboardSettings.persistHistory ? normalizeClipboardItems(readJson(historyPath(), [])) : [];
  pruneClipboard();
}
function saveClipboardSettings() {
  const saved = writeJson(settingsPath(), clipboardSettings);
  if (!saved) notifyPersistenceError('剪贴板设置保存失败，请检查磁盘空间或文件权限。');
  return saved;
}
function saveClipboardHistory() {
  if (!clipboardSettings.persistHistory) {
    try { fs.rmSync(historyPath(), { force: true }); return true; } catch { notifyPersistenceError('无法删除旧的剪贴板历史文件。'); return false; }
  }
  const saved = writeJson(historyPath(), clipboardItems);
  if (!saved) notifyPersistenceError('剪贴板历史保存失败，请检查磁盘空间或文件权限。');
  return saved;
}
function publicItems() { return clipboardItems.map(({ html, fileData, ...item }) => item); }
function notifyClipboard() { if (win && !win.isDestroyed()) win.webContents.send('clipboard-history-changed', publicItems()); }

function runPowerShell(script, callback, timeout = 3000) {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout }, callback);
}
function foregroundInfo(callback) {
  const script = "$sig='[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint processId);';Add-Type -MemberDefinition $sig -Name Win32 -Namespace QH; $p=0; $h=[QH.Win32]::GetForegroundWindow();[QH.Win32]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null;$n=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName;Write-Output ($h.ToInt64().ToString()+'|'+$n)";
  runPowerShell(script, (_error, stdout) => {
    const [handle = '', name = ''] = String(stdout || '').trim().split('|');
    callback({ handle: /^\d+$/.test(handle) ? handle : '', name: name.toLowerCase() });
  });
}
function readFileDropPaths(callback) {
  const script = "Add-Type -AssemblyName System.Windows.Forms;$v=[Windows.Forms.Clipboard]::GetFileDropList();if($v){@($v)|ConvertTo-Json -Compress}";
  runPowerShell(script, (_error, stdout) => {
    try {
      const parsed = JSON.parse(String(stdout || '').trim() || '[]');
      callback((Array.isArray(parsed) ? parsed : [parsed]).map(String).filter(Boolean).slice(0, 500));
    } catch { callback([]); }
  });
}
function addClipboardItem(payload) {
  const item = normalizeClipboardItem(payload);
  if (!item) {
    log('main', 'warn', 'Clipboard item skipped because it exceeded the size limit');
    if (win && !win.isDestroyed()) win.webContents.send('persistence-error', '剪贴板内容超过 20 MB，已跳过记录。');
    return;
  }
  const existing = clipboardItems.find(entry => entry.hash === item.hash);
  if (existing) clipboardItems = clipboardItems.filter(entry => entry.id !== existing.id);
  item.id = existing?.id || item.id;
  item.pinned = existing?.pinned || false;
  clipboardItems.unshift(item);
  pruneClipboard();
  saveClipboardHistory();
  notifyClipboard();
}
function finishClipboardCapture(base, filePaths) {
  const type = filePaths.length ? 'files' : base.hasImage ? 'image' : (base.html && base.html !== base.text ? 'rich' : 'text');
  const text = filePaths.length ? filePaths.join('\n') : base.text;
  const signatureContent = type === 'files' ? text : (base.imageData || text);
  const signature = hash(`${type}\0${signatureContent}\0${base.html}\0${JSON.stringify(filePaths)}`);
  if (signature === lastClipboardHash) { captureBusy = false; return; }
  lastClipboardHash = signature;
  foregroundInfo(source => {
    captureBusy = false;
    if (clipboardSettings.excludedApps.some(name => source.name.includes(name))) return;
    addClipboardItem({ id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type, text, html: base.html, imageData: base.imageData, fileData: base.fileData, filePaths, source: source.name || '未知应用', createdAt: Date.now(), pinned: false, hash: signature });
  });
}
function captureClipboard() {
  if (clipboardSettings.paused || captureBusy) return;
  captureBusy = true;
  try {
    const formats = clipboard.availableFormats();
    const fileBuffer = formats.includes('FileNameW') ? clipboard.readBuffer('FileNameW') : Buffer.alloc(0);
    const image = clipboard.readImage();
    const hasImage = !image.isEmpty();
    const text = clipboard.readText();
    const html = clipboard.readHTML();
    const imageData = hasImage ? image.toDataURL() : '';
    if (!fileBuffer.length && !hasImage && !text.trim() && !html.trim()) { captureBusy = false; return; }
    const base = { hasImage, text, html, imageData, fileData: fileBuffer.length ? fileBuffer.toString('base64') : '' };
    if (fileBuffer.length) readFileDropPaths(paths => finishClipboardCapture(base, paths.length ? paths : [fileBuffer.toString('utf16le').replace(/\0+$/, '')].filter(Boolean)));
    else finishClipboardCapture(base, []);
  } catch {
    captureBusy = false;
  }
}
function startClipboardMonitor() {
  clearInterval(clipboardTimer);
  clipboardTimer = setInterval(captureClipboard, 700);
  captureClipboard();
}
function clipboardSnapshot(callback) {
  const image = clipboard.readImage();
  const fileBuffer = clipboard.availableFormats().includes('FileNameW') ? clipboard.readBuffer('FileNameW') : Buffer.alloc(0);
  const snapshot = { text: clipboard.readText(), html: clipboard.readHTML(), imageData: image.isEmpty() ? '' : image.toDataURL(), fileData: fileBuffer.length ? fileBuffer.toString('base64') : '', filePaths: [] };
  if (fileBuffer.length) readFileDropPaths(paths => { snapshot.filePaths = paths; callback(snapshot); });
  else callback(snapshot);
}
function restoreClipboardSnapshot(snapshot) {
  if (snapshot.filePaths?.length) setFileDropList(snapshot.filePaths, () => {});
  else if (snapshot.fileData) clipboard.writeBuffer('FileNameW', Buffer.from(snapshot.fileData, 'base64'));
  else if (snapshot.imageData) clipboard.writeImage(nativeImage.createFromDataURL(snapshot.imageData));
  else if (snapshot.html) clipboard.write({ text: snapshot.text || '', html: snapshot.html });
  else clipboard.writeText(snapshot.text || '');
}
function clipboardSnapshotHash(snapshot) {
  const type = snapshot.fileData ? 'files' : snapshot.imageData ? 'image' : (snapshot.html && snapshot.html !== snapshot.text ? 'rich' : 'text');
  const content = type === 'files' ? (snapshot.filePaths?.join('\n') || snapshot.fileData) : (snapshot.imageData || snapshot.text);
  return hash(`${type}\0${content}\0${snapshot.html}\0${JSON.stringify(snapshot.filePaths || [])}`);
}
function setFileDropList(paths, callback) {
  const encoded = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64');
  const script = `$j=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$p=ConvertFrom-Json $j;Add-Type -AssemblyName System.Windows.Forms;$c=New-Object System.Collections.Specialized.StringCollection;foreach($x in @($p)){[void]$c.Add([string]$x)};[Windows.Forms.Clipboard]::SetFileDropList($c)`;
  runPowerShell(script, error => callback(!error), 5000);
}
function writeClipboardItem(item, plain, callback) {
  try {
    if (item.type === 'files' && !plain && item.filePaths?.length) { setFileDropList(item.filePaths, callback); return; }
    if (item.type === 'files' && !plain && item.fileData) clipboard.writeBuffer('FileNameW', Buffer.from(item.fileData, 'base64'));
    else if (item.type === 'image' && !plain) clipboard.writeImage(nativeImage.createFromDataURL(item.imageData));
    else if (!plain && item.html) clipboard.write({ text: item.text || '', html: item.html });
    else clipboard.writeText(item.text || item.filePaths?.join('\n') || '');
    callback(true);
  } catch { callback(false); }
}
function currentClipboardMatches(item) {
  try {
    if (item.type === 'image') return clipboard.readImage().toDataURL() === item.imageData;
    if (item.type === 'files') {
      const buffer = clipboard.availableFormats().includes('FileNameW') ? clipboard.readBuffer('FileNameW') : Buffer.alloc(0);
      const firstPath = buffer.length ? buffer.toString('utf16le').replace(/\0+$/, '') : '';
      return Boolean(firstPath && item.filePaths?.includes(firstPath));
    }
    return clipboard.readText() === (item.text || '');
  } catch { return false; }
}
function sendPasteKeystroke(targetHandle, callback) {
  const safeHandle = /^\d+$/.test(String(targetHandle || '')) ? String(targetHandle) : '0';
  const script = `$sig='[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr hWnd);';Add-Type -MemberDefinition $sig -Name Win32Paste -Namespace QH;if(${safeHandle} -gt 0){[QH.Win32Paste]::SetForegroundWindow([IntPtr]::new([Int64]${safeHandle}))|Out-Null;Start-Sleep -Milliseconds 100};Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('^v')`;
  setTimeout(() => runPowerShell(script, () => callback?.(), 5000), 120);
}
function pasteItem(id, plain = false, fromPicker = false, targetHandle = '') {
  return new Promise(resolve => {
    const item = clipboardItems.find(entry => entry.id === id);
    if (!item) { resolve(false); return; }
    clipboardSnapshot(previous => writeClipboardItem(item, plain, written => {
      if (!written) { notifyPersistenceError('无法写入系统剪贴板。'); resolve(false); return; }
      lastClipboardHash = item.hash;
      if (fromPicker) win?.hide();
      sendPasteKeystroke(targetHandle || pickerTargetHandle, () => {
        setTimeout(() => {
          if (currentClipboardMatches(item)) {
            restoreClipboardSnapshot(previous);
            lastClipboardHash = clipboardSnapshotHash(previous);
            captureClipboard();
          }
        }, 900);
        resolve(true);
      });
    }));
  });
}

function showWindow() { if (!win) return; win.show(); win.restore(); win.focus(); }
function checkTaskReminders(now = Date.now()) {
  if (!taskRemindersEnabled || !Notification.isSupported()) return;
  for (const task of collectDueReminders(taskReminders, notifiedTaskKeys, now, taskReminderMinutes)) {
    const key = reminderKey(task);
    notifiedTaskKeys.add(key);
    const minutes = Math.max(1, Math.ceil((task.dueAt - now) / 60000));
    try {
      const notification = new Notification({
        title: '任务即将到期',
        body: `“${task.title}”将在 ${minutes} 分钟后到期`,
        icon: path.join(__dirname, 'assets', 'app-icon.ico'),
        silent: false
      });
      activeTaskNotifications.add(notification);
      notification.on('click', () => {
        showWindow();
        win?.webContents.send('open-task-reminder', { id: task.id, categoryId: task.categoryId });
      });
      notification.on('close', () => activeTaskNotifications.delete(notification));
      notification.show();
      log('main', 'info', 'Task due reminder shown', { remainingMinutes: minutes });
    } catch (error) {
      notifiedTaskKeys.delete(key);
      log('main', 'error', 'Task due reminder failed', error);
    }
  }
}
function syncTaskReminders(payload) {
  taskRemindersEnabled = payload?.enabled !== false;
  taskReminderMinutes = normalizeReminderMinutes(payload?.minutes);
  taskReminders = normalizeReminderTasks(payload?.tasks);
  const activeKeys = new Set(taskReminders.map(reminderKey));
  notifiedTaskKeys = new Set([...notifiedTaskKeys].filter(key => activeKeys.has(key)));
  checkTaskReminders();
}
function startTaskReminderMonitor() {
  clearInterval(taskReminderTimer);
  taskReminderTimer = setInterval(checkTaskReminders, 15000);
  log('main', Notification.isSupported() ? 'info' : 'warn', 'Task reminder monitor started', { notificationsSupported: Notification.isSupported(), defaultLeadMinutes: DEFAULT_REMINDER_MINUTES });
}
function showClipboardPicker() {
  foregroundInfo(info => {
    pickerTargetHandle = info.handle;
    showWindow();
    win?.webContents.send('show-clipboard-history');
  });
}
function registerClipboardShortcuts() {
  globalShortcut.unregisterAll();
  shortcutStatus = { open: false, direct: [] };
  try { shortcutStatus.open = globalShortcut.register(clipboardSettings.openShortcut, showClipboardPicker); } catch {}
  if (clipboardSettings.directPaste) {
    for (let index = 1; index <= 9; index += 1) {
      try {
        const registered = globalShortcut.register(`Alt+${index}`, () => {
          const item = clipboardItems[index - 1];
          if (!item) return;
          foregroundInfo(info => pasteItem(item.id, false, false, info.handle));
        });
        if (registered) shortcutStatus.direct.push(index);
      } catch {}
    }
  }
  log('main', shortcutStatus.open ? 'info' : 'warn', 'Clipboard shortcuts registered', { openShortcut: clipboardSettings.openShortcut, openAvailable: shortcutStatus.open, directAvailable: shortcutStatus.direct.length });
  win?.webContents.send('clipboard-shortcut-status', shortcutStatus);
}
function createTray() {
  tray?.destroy();
  tray = new Tray(path.join(__dirname, 'assets', 'app-icon.ico'));
  tray.setToolTip('千幻桌面便笺');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示便笺', click: showWindow },
    { label: '剪贴板历史', click: showClipboardPicker },
    { label: clipboardSettings.paused ? '继续记录剪贴板' : '暂停记录剪贴板', click: () => { clipboardSettings.paused = !clipboardSettings.paused; saveClipboardSettings(); createTray(); notifyClipboard(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', showWindow);
  log('main', 'info', 'System tray created');
}
function loginOptions(openAtLogin) {
  const portablePath = process.env.PORTABLE_EXECUTABLE_FILE;
  return { openAtLogin, path: portablePath || process.execPath, args: portablePath || app.isPackaged ? [] : [path.resolve(__dirname)] };
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.setAlwaysOnTop(false);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.loadFile('index.html');
  win.webContents.on('render-process-gone', (_event, details) => log('main', 'error', 'Renderer process gone', { reason: details.reason, exitCode: details.exitCode }));
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => log('main', 'error', 'Renderer failed to load', { errorCode, errorDescription }));
  log('main', 'info', 'Main window created', { width: 390, height: Math.min(720, area.height - 100) });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  log('main', 'info', 'Another instance is already running; exiting');
  app.quit();
} else {
  app.on('second-instance', () => { log('main', 'info', 'Second-instance launch redirected to the existing window'); showWindow(); });
  app.whenReady().then(() => {
    app.setAppUserModelId('com.qianhuan.desktopnote');
    log('main', 'info', 'Electron app ready');
    loadClipboardData();
    log('main', 'info', 'Clipboard data loaded', { itemCount: clipboardItems.length, persistenceEnabled: clipboardSettings.persistHistory });
    ipcMain.on('renderer-log', (_event, level, message, details) => log('renderer', level, message, details));
    ipcMain.on('task-reminders:sync', (_event, payload) => syncTaskReminders(payload));
    ipcMain.handle('open-log-directory', async () => {
      const error = await shell.openPath(getLogDirectory());
      if (error) log('main', 'error', 'Failed to open log directory', { error });
      else log('main', 'info', 'Log directory opened by user');
      return error || '';
    });
    ipcMain.handle('choose-background', async () => {
      const result = await dialog.showOpenDialog(win, { title: '选择背景图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.on('window-action', (_event, action) => {
      if (!win) return;
      if (action === 'close') { log('main', 'info', 'Application exit requested from window'); app.quit(); }
      if (action === 'minimize') { win.hide(); log('main', 'debug', 'Window hidden'); }
      if (action === 'toggle-top') { win.setAlwaysOnTop(!win.isAlwaysOnTop()); log('main', 'info', 'Always-on-top changed', { enabled: win.isAlwaysOnTop() }); }
    });
    ipcMain.handle('is-always-on-top', () => win?.isAlwaysOnTop() ?? false);
    ipcMain.handle('is-devtools-opened', () => win?.webContents.isDevToolsOpened() ?? false);
    ipcMain.handle('get-auto-launch', () => app.getLoginItemSettings(loginOptions(false)).openAtLogin);
    ipcMain.handle('set-auto-launch', (_event, enabled) => { app.setLoginItemSettings(loginOptions(Boolean(enabled))); return app.getLoginItemSettings(loginOptions(Boolean(enabled))).openAtLogin; });
    ipcMain.on('resize-window', (_event, width, height) => {
      if (!win) return;
      const safeWidth = Number(width), safeHeight = Number(height);
      if (!Number.isFinite(safeWidth) || !Number.isFinite(safeHeight)) return;
      const bounds = win.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      win.setBounds({ x: bounds.x, y: bounds.y, width: Math.max(MIN_WINDOW_WIDTH, Math.min(area.width * 4, Math.round(safeWidth))), height: Math.max(MIN_WINDOW_HEIGHT, Math.min(area.height * 4, Math.round(safeHeight))) }, false);
    });
    ipcMain.handle('clipboard-history:get', () => ({ items: publicItems(), settings: clipboardSettings, shortcuts: shortcutStatus }));
    ipcMain.handle('clipboard-history:settings', (_event, patch) => {
      clipboardSettings = normalizeSettings({ ...clipboardSettings, ...(patch && typeof patch === 'object' ? patch : {}) });
      pruneClipboard();
      const saved = saveClipboardSettings() && saveClipboardHistory();
      registerClipboardShortcuts();
      createTray();
      notifyClipboard();
      log('main', saved ? 'info' : 'error', 'Clipboard settings updated', { saved, maxItems: clipboardSettings.maxItems, expireDays: clipboardSettings.expireDays, persistenceEnabled: clipboardSettings.persistHistory, directPasteEnabled: clipboardSettings.directPaste });
      return { settings: clipboardSettings, shortcuts: shortcutStatus, saved };
    });
    ipcMain.handle('clipboard-history:pin', (_event, id) => { const item = clipboardItems.find(entry => entry.id === id); if (item) item.pinned = !item.pinned; pruneClipboard(); saveClipboardHistory(); notifyClipboard(); return publicItems(); });
    ipcMain.handle('clipboard-history:delete', (_event, id) => { clipboardItems = clipboardItems.filter(item => item.id !== id); saveClipboardHistory(); notifyClipboard(); return publicItems(); });
    ipcMain.handle('clipboard-history:clear', () => { clipboardItems = clipboardItems.filter(item => item.pinned); pruneClipboard(); saveClipboardHistory(); notifyClipboard(); return publicItems(); });
    ipcMain.handle('clipboard-history:paste', (_event, id, plain) => pasteItem(id, Boolean(plain), true, pickerTargetHandle));
    createWindow();
    createTray();
    registerClipboardShortcuts();
    startClipboardMonitor();
    startTaskReminderMonitor();
  });
  app.on('will-quit', () => { log('main', 'info', 'Application shutting down'); clearInterval(clipboardTimer); clearInterval(taskReminderTimer); activeTaskNotifications.clear(); globalShortcut.unregisterAll(); });
  app.on('window-all-closed', () => app.quit());
}
