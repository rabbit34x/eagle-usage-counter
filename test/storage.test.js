const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getDatabasePath,
  getPreviousSidecarDatabasePath,
  getSidecarDatabasePath,
} = require('../js/storage');

test('places the database beside the Eagle library', () => {
  const libraryPath = path.join(path.sep, 'share', 'Pictures.library');
  assert.equal(
    getSidecarDatabasePath(libraryPath),
    path.join(
      path.sep,
      'share',
      'Pictures.library.plugin-data',
      'sqlite',
      'usage-counter',
      'usage.sqlite',
    ),
  );
});

test('migrates the previous sidecar database to the shared plugin-data layout', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-storage-'));
  const libraryPath = path.join(directory, 'Pictures.library');
  const previous = getPreviousSidecarDatabasePath(libraryPath);
  const expected = getSidecarDatabasePath(libraryPath);
  try {
    fs.mkdirSync(path.dirname(previous), { recursive: true });
    fs.writeFileSync(previous, 'existing database');

    assert.equal(getDatabasePath(libraryPath), expected);
    assert.equal(fs.readFileSync(expected, 'utf8'), 'existing database');
    assert.equal(fs.readFileSync(previous, 'utf8'), 'existing database');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
