const path = require('path');

function getDatabasePath(libraryPath) {
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

module.exports = { getDatabasePath };
