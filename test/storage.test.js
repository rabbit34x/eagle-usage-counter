const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { getSidecarDatabasePath } = require('../js/storage');

test('places the database beside the Eagle library', () => {
  const libraryPath = path.join(path.sep, 'share', 'Pictures.library');
  assert.equal(
    getSidecarDatabasePath(libraryPath),
    path.join(path.sep, 'share', 'Pictures.library.usage-counter', 'usage.sqlite'),
  );
});
