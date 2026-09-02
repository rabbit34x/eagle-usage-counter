const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { getDatabasePath } = require('../js/storage');

test('places the database in the shared plugin-data hierarchy', () => {
  const libraryPath = path.join(path.sep, 'share', 'Pictures.library');
  assert.equal(
    getDatabasePath(libraryPath),
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
