const fs = require('fs');
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

function getLegacyDatabasePath(libraryPath) {
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

function getPreviousSidecarDatabasePath(libraryPath) {
  const normalizedPath = path.resolve(libraryPath).normalize();
  const sidecarName = `${path.basename(normalizedPath)}.usage-counter`;
  return path.join(path.dirname(normalizedPath), sidecarName, 'usage.sqlite');
}

function getSidecarDatabasePath(libraryPath) {
  const normalizedPath = path.resolve(libraryPath).normalize();
  const dataRootName = `${path.basename(normalizedPath)}.plugin-data`;
  return path.join(
    path.dirname(normalizedPath),
    dataRootName,
    'sqlite',
    'usage-counter',
    'usage.sqlite',
  );
}

function getDatabasePath(libraryPath) {
  const destination = getSidecarDatabasePath(libraryPath);
  const migrationSources = [
    getPreviousSidecarDatabasePath(libraryPath),
    getLegacyDatabasePath(libraryPath),
  ];
  const source = migrationSources.find((candidate) => fs.existsSync(candidate));

  if (!fs.existsSync(destination) && source) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return destination;
}

module.exports = {
  getDatabasePath,
  getLegacyDatabasePath,
  getPreviousSidecarDatabasePath,
  getSidecarDatabasePath,
  resolveUserDataPath,
};
