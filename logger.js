const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RETENTION_DAYS = 7;
let logDirectory = '';

const dayStamp = date => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
function initLogger(userDataDirectory) {
  logDirectory = path.join(userDataDirectory, 'logs');
  try { fs.mkdirSync(logDirectory, { recursive: true }); cleanupOldLogs(); } catch {}
  return logDirectory;
}
function cleanupOldLogs() {
  if (!logDirectory) return;
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  try {
    for (const entry of fs.readdirSync(logDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      const file = path.join(logDirectory, entry.name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch {}
}
function rotateIfNeeded(scope) {
  const current = path.join(logDirectory, `${scope}.log`);
  try {
    if (!fs.existsSync(current)) return current;
    const stats = fs.statSync(current);
    const changedDay = dayStamp(stats.mtime) !== dayStamp(new Date());
    if (!changedDay && stats.size < MAX_FILE_BYTES) return current;
    const suffix = `${dayStamp(stats.mtime)}-${Date.now()}`;
    fs.renameSync(current, path.join(logDirectory, `${scope}-${suffix}.log`));
    cleanupOldLogs();
  } catch {}
  return current;
}
function safeDetails(value) {
  if (value === undefined) return '';
  const sanitizeString = item => String(item)
    .replace(/file:\/\/\/[^\s"'<>]+/gi, '[PATH]')
    .replace(/[a-z]:[\\/][^\r\n"'<>|]*/gi, '[PATH]')
    .replace(/\\\\[^\\\s]+\\[^\r\n"'<>|]*/g, '[PATH]');
  if (value instanceof Error) return ` ${JSON.stringify({ name: value.name, message: sanitizeString(value.message) })}`;
  try {
    const json = JSON.stringify(value, (key, item) => {
      if (/password|token|secret|clipboardContent|noteContent|imageData|html/i.test(key)) return '[REDACTED]';
      if (typeof item === 'string') {
        const sanitized = sanitizeString(item);
        return sanitized.length > 1000 ? `${sanitized.slice(0, 1000)}…` : sanitized;
      }
      return item;
    });
    return json ? ` ${json}` : '';
  } catch { return ' [unserializable details]'; }
}
function log(scope, level, message, details) {
  if (!logDirectory) return false;
  const safeScope = scope === 'renderer' ? 'renderer' : 'main';
  const safeLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level.toUpperCase() : 'INFO';
  const safeMessage = String(message || '').replace(/[\r\n]+/g, ' ').slice(0, 2000);
  try {
    const file = rotateIfNeeded(safeScope);
    fs.appendFileSync(file, `[${new Date().toISOString()}] [${safeLevel}] ${safeMessage}${safeDetails(details)}\n`, 'utf8');
    return true;
  } catch { return false; }
}
function getLogDirectory() { return logDirectory; }

module.exports = { initLogger, log, getLogDirectory, cleanupOldLogs, MAX_FILE_BYTES, RETENTION_DAYS };
