const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');
const { UsageDatabase } = require('../js/database');

let SQL;
test.before(async () => { SQL = await initSqlJs(); });

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-usage-counter-'));
  const database = new UsageDatabase(SQL, path.join(directory, 'usage.sqlite'));
  return { database, directory };
}

function item(id, name = id) {
  return { id, name, ext: 'png', thumbnailURL: `file:///${id}.png` };
}

test('records one event per unique selected item and ranks items', () => {
  const { database, directory } = fixture();
  try {
    database.recordUsage([item('a', 'Alpha'), item('a', 'Alpha'), item('b', 'Beta')]);
    database.recordUsage([item('a', 'Alpha')]);

    assert.deepEqual(database.getStats(), {
      event_count: 3,
      item_count: 2,
      last_used_at: database.getStats().last_used_at,
    });
    const ranking = database.getRanking();
    assert.equal(ranking[0].eagle_item_id, 'a');
    assert.equal(ranking[0].usage_count, 2);
    assert.equal(ranking[1].usage_count, 1);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('undo reverts the whole latest batch without deleting audit rows', () => {
  const { database, directory } = fixture();
  try {
    database.recordUsage([item('a')]);
    database.recordUsage([item('a'), item('b')]);
    const undone = database.undoLastBatch();

    assert.equal(undone.count, 2);
    assert.equal(database.getStats().event_count, 1);
    assert.equal(database.query('SELECT COUNT(*) AS count FROM usage_events')[0].count, 3);
    assert.equal(database.query('SELECT COUNT(*) AS count FROM usage_events WHERE reverted_at IS NOT NULL')[0].count, 2);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('decrement reverts the latest event for each selected item', () => {
  const { database, directory } = fixture();
  try {
    database.recordUsage([item('a'), item('b')]);
    database.recordUsage([item('a')]);
    const result = database.decrementUsage(['a', 'b', 'missing']);

    assert.equal(result.count, 2);
    assert.equal(database.getCounts(['a']).get('a').usage_count, 1);
    assert.equal(database.getCounts(['b']).has('b'), false);
    assert.equal(database.query('SELECT COUNT(*) AS count FROM usage_events')[0].count, 3);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('separate plugin views do not overwrite each other\'s writes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-usage-counter-'));
  const filePath = path.join(directory, 'usage.sqlite');
  try {
    const inspector = new UsageDatabase(SQL, filePath);
    const dashboard = new UsageDatabase(SQL, filePath);
    inspector.recordUsage([item('a')]);
    dashboard.recordUsage([item('b')]);

    assert.equal(inspector.getStats().event_count, 2);
    assert.equal(dashboard.getStats().event_count, 2);
    inspector.close();
    dashboard.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('persists and reopens the sqlite file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-usage-counter-'));
  const filePath = path.join(directory, 'usage.sqlite');
  try {
    const first = new UsageDatabase(SQL, filePath);
    first.recordUsage([item('a')]);
    first.close();

    const reopened = new UsageDatabase(SQL, filePath);
    assert.equal(reopened.getStats().event_count, 1);
    reopened.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('restore replaces the current database', () => {
  const source = fixture();
  const target = fixture();
  try {
    source.database.recordUsage([item('source')]);
    target.database.recordUsage([item('target'), item('other')]);
    target.database.replace(source.database.exportBytes());

    assert.equal(target.database.getStats().event_count, 1);
    assert.equal(target.database.getRanking()[0].eagle_item_id, 'source');
  } finally {
    source.database.close();
    target.database.close();
    fs.rmSync(source.directory, { recursive: true, force: true });
    fs.rmSync(target.directory, { recursive: true, force: true });
  }
});
