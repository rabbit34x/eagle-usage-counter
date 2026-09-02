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

    const stats = database.getStats();
    assert.equal(stats.event_count, 3);
    assert.equal(stats.item_count, 2);
    assert.ok(stats.last_used_at);
    const ranking = database.getRanking();
    assert.equal(ranking[0].eagle_item_id, 'a');
    assert.equal(ranking[0].usage_count, 2);
    assert.equal(ranking[1].usage_count, 1);
    const activity = database.getDailyActivity({ since: Date.now() - 60_000 });
    assert.equal(activity.length, 1);
    assert.equal(activity[0].usage_count, 3);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('aggregates period statistics, time series, and weekdays', () => {
  const { database, directory } = fixture();
  try {
    database.recordUsage([item('a'), item('b')]);
    database.recordUsage([item('a')]);
    const monday = new Date(2025, 0, 6, 10).getTime();
    const tuesday = new Date(2025, 0, 7, 11).getTime();
    database.transaction(() => {
      database.db.run('UPDATE usage_events SET used_at = ? WHERE id IN (1, 2)', [monday]);
      database.db.run('UPDATE usage_events SET used_at = ? WHERE id = 3', [tuesday]);
    });
    const range = {
      since: new Date(2025, 0, 6).getTime(),
      until: new Date(2025, 0, 12, 23, 59, 59, 999).getTime(),
    };

    const stats = database.getPeriodStats(range);
    assert.equal(stats.event_count, 3);
    assert.equal(stats.item_count, 2);
    assert.equal(stats.active_days, 2);
    const series = database.getTimeSeries({ ...range, granularity: 'day' });
    assert.deepEqual(series.map((row) => [row.usage_count, row.item_count]), [[2, 2], [1, 1]]);
    const weekdays = database.getWeekdayStats(range);
    assert.deepEqual(weekdays.map((row) => [row.weekday, row.usage_count]), [[1, 2], [2, 1]]);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('undated adjustments affect totals but not time-based statistics', () => {
  const { database, directory } = fixture();
  try {
    database.recordUsage([item('a')]);
    database.recordAdjustment([item('a'), item('b')], 5);

    assert.equal(database.getCounts(['a']).get('a').usage_count, 6);
    assert.equal(database.getCounts(['a']).get('a').undated_count, 5);
    assert.equal(database.getPeriodStats().event_count, 1);
    const allStats = database.getPeriodStats({ includeUndated: true });
    assert.equal(allStats.event_count, 11);
    assert.equal(allStats.item_count, 2);
    assert.equal(allStats.undated_count, 10);
    assert.deepEqual(database.getRanking({ includeUndated: true }).map((row) => row.usage_count), [6, 5]);
    assert.equal(database.getDailyActivity().reduce((sum, row) => sum + row.usage_count, 0), 1);

    database.decrementUsage(['a', 'b']);
    assert.equal(database.getCounts(['a']).get('a').undated_count, 4);
    assert.equal(database.getCounts(['b']).get('b').undated_count, 4);
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

test('synchronizes trashed items and purges missing item history', () => {
  const { database, directory } = fixture();
  try {
    database.recordUsage([item('active'), item('missing')]);
    database.recordAdjustment([item('active')], 2);
    const result = database.synchronizeItems([{ id: 'active', isDeleted: true }], ['missing']);

    assert.equal(result.trashedCount, 1);
    assert.equal(result.purgedCount, 1);
    assert.deepEqual(database.getTrackedItemIds(), ['active']);
    assert.equal(database.getStats().event_count, 0);
    assert.equal(database.getCounts(['active']).get('active').usage_count, 3);

    database.synchronizeItems([{ id: 'active', isDeleted: false }], []);
    assert.equal(database.getStats().event_count, 3);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('migrates a version 1 schema without losing usage events', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-usage-counter-'));
  const filePath = path.join(directory, 'usage.sqlite');
  try {
    const legacy = new SQL.Database();
    legacy.run(`
      CREATE TABLE items (
        eagle_item_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
        extension TEXT NOT NULL DEFAULT '', thumbnail_url TEXT NOT NULL DEFAULT '',
        first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, eagle_item_id TEXT NOT NULL,
        batch_id TEXT NOT NULL, used_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
        reverted_at INTEGER
      );
      INSERT INTO items VALUES ('legacy', 'Legacy', 'png', '', 1, 1);
      INSERT INTO usage_events (eagle_item_id, batch_id, used_at) VALUES ('legacy', 'batch', 1000);
      PRAGMA user_version = 1;
    `);
    fs.writeFileSync(filePath, Buffer.from(legacy.export()));
    legacy.close();

    const migrated = new UsageDatabase(SQL, filePath);
    assert.equal(migrated.query('PRAGMA user_version')[0].user_version, 3);
    assert.equal(migrated.getCounts(['legacy']).get('legacy').usage_count, 1);
    assert.equal(migrated.query('SELECT recorded_at FROM usage_events')[0].recorded_at, 1000);
    migrated.close();
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

