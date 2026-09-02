const os = require('os');
const path = require('path');
const crypto = require('crypto');

function resolveUserDataPath() {
  try {
    const electron = require('electron');
    if (electron.remote?.app) return electron.remote.app.getPath('userData');
  } catch (_) {
    // Fall through to stable OS-specific paths.
  }

  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function getDatabasePath(libraryPath) {
  const normalizedPath = path.resolve(libraryPath).normalize();
  const libraryHash = crypto.createHash('sha256').update(normalizedPath).digest('hex');
  return path.join(
    resolveUserDataPath(),
    'eagle-usage-counter',
    'libraries',
    libraryHash,
    'usage.sqlite',
  );
}

module.exports = { getDatabasePath, resolveUserDataPath };
