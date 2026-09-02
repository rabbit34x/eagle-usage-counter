const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class UsageDatabase {
  constructor(SQL, filePath) {
    this.SQL = SQL;
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const bytes = fs.existsSync(filePath) ? fs.readFileSync(filePath) : undefined;
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.db.run('PRAGMA foreign_keys = ON');
    const migrated = this.migrate();
    this.fileSignature = this.getFileSignature();
    if (!bytes || migrated) this.persist();
  }

  migrate() {
    const version = this.db.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0;
    if (version > 2) throw new Error(`未対応のデータベースバージョンです: ${version}`);
    if (version === 0) {
      this.db.run(`
        CREATE TABLE items (
          eagle_item_id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          extension TEXT NOT NULL DEFAULT '',
          thumbnail_url TEXT NOT NULL DEFAULT '',
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          eagle_item_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          used_at INTEGER NOT NULL,
          recorded_at INTEGER NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          reverted_at INTEGER,
          FOREIGN KEY (eagle_item_id) REFERENCES items(eagle_item_id)
        );
        CREATE TABLE usage_adjustments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          eagle_item_id TEXT NOT NULL,
          amount INTEGER NOT NULL CHECK(amount > 0),
          created_at INTEGER NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          reverted_at INTEGER,
          FOREIGN KEY (eagle_item_id) REFERENCES items(eagle_item_id)
        );
        CREATE INDEX idx_usage_events_item_time ON usage_events(eagle_item_id, used_at);
        CREATE INDEX idx_usage_events_recorded ON usage_events(eagle_item_id, recorded_at);
        CREATE INDEX idx_usage_events_time ON usage_events(used_at);
        CREATE INDEX idx_usage_events_batch ON usage_events(batch_id);
        CREATE INDEX idx_usage_adjustments_item ON usage_adjustments(eagle_item_id, created_at);
        PRAGMA user_version = 2;
      `);
      return true;
    }
    if (version === 1) {
      this.db.run(`
        ALTER TABLE usage_events ADD COLUMN recorded_at INTEGER;
        UPDATE usage_events SET recorded_at = used_at WHERE recorded_at IS NULL;
        CREATE TABLE usage_adjustments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          eagle_item_id TEXT NOT NULL,
          amount INTEGER NOT NULL CHECK(amount > 0),
          created_at INTEGER NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          reverted_at INTEGER,
          FOREIGN KEY (eagle_item_id) REFERENCES items(eagle_item_id)
        );
        CREATE INDEX idx_usage_events_recorded ON usage_events(eagle_item_id, recorded_at);
        CREATE INDEX idx_usage_adjustments_item ON usage_adjustments(eagle_item_id, created_at);
        PRAGMA user_version = 2;
      `);
      return true;
    }
    return false;
  }

  transaction(action) {
    const releaseLock = this.acquireLock();
    try {
      this.reload(true);
      this.db.run('BEGIN IMMEDIATE');
      try {
        const result = action();
        this.db.run('COMMIT');
        this.persist();
        return result;
      } catch (error) {
        this.db.run('ROLLBACK');
        throw error;
      }
    } finally {
      releaseLock();
    }
  }

  recordUsage(items, { note = '', usedAt = Date.now(), repeat = 1 } = {}) {
    const uniqueItems = [...new Map(items.map((item) => [item.id, item])).values()];
    const repetitions = Math.max(1, Math.trunc(repeat));
    if (uniqueItems.length === 0) return { batchId: null, count: 0 };

    const recordedAt = Date.now();
    const batchId = crypto.randomUUID();
    this.transaction(() => {
      const upsert = this.prepareItemUpsert();
      const insertEvent = this.db.prepare(`
        INSERT INTO usage_events (eagle_item_id, batch_id, used_at, recorded_at, note)
        VALUES (?, ?, ?, ?, ?)
      `);
      try {
        for (const item of uniqueItems) {
          this.upsertItem(upsert, item, recordedAt);
          for (let index = 0; index < repetitions; index += 1) {
            insertEvent.run([item.id, batchId, usedAt, recordedAt, note]);
          }
        }
      } finally {
        upsert.free();
        insertEvent.free();
      }
    });
    return { batchId, count: uniqueItems.length * repetitions };
  }

  recordAdjustment(items, amount, note = '') {
    const uniqueItems = [...new Map(items.map((item) => [item.id, item])).values()];
    const adjustment = Math.trunc(amount);
    if (uniqueItems.length === 0 || adjustment < 1) return { count: 0 };

    const now = Date.now();
    this.transaction(() => {
      const upsert = this.prepareItemUpsert();
      const insertAdjustment = this.db.prepare(`
        INSERT INTO usage_adjustments (eagle_item_id, amount, created_at, note)
        VALUES (?, ?, ?, ?)
      `);
      try {
        for (const item of uniqueItems) {
          this.upsertItem(upsert, item, now);
          insertAdjustment.run([item.id, adjustment, now, note]);
        }
      } finally {
        upsert.free();
        insertAdjustment.free();
      }
    });
    return { count: uniqueItems.length * adjustment };
  }

  prepareItemUpsert() {
    return this.db.prepare(`
      INSERT INTO items (
        eagle_item_id, name, extension, thumbnail_url, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(eagle_item_id) DO UPDATE SET
        name = excluded.name,
        extension = excluded.extension,
        thumbnail_url = excluded.thumbnail_url,
        last_seen_at = excluded.last_seen_at
    `);
  }

  upsertItem(statement, item, timestamp) {
    statement.run([
      item.id,
      item.name || '',
      item.ext || '',
      item.thumbnailURL || '',
      timestamp,
      timestamp,
    ]);
  }

  decrementUsage(itemIds) {
    const uniqueIds = [...new Set(itemIds)];
    if (uniqueIds.length === 0) return { count: 0 };

    let count = 0;
    this.transaction(() => {
      const findLatest = this.db.prepare(`
        SELECT operation_id, operation_type, recorded_at FROM (
          SELECT id AS operation_id, 'event' AS operation_type, recorded_at
          FROM usage_events
          WHERE eagle_item_id = ? AND reverted_at IS NULL
          UNION ALL
          SELECT id AS operation_id, 'adjustment' AS operation_type, created_at AS recorded_at
          FROM usage_adjustments
          WHERE eagle_item_id = ? AND reverted_at IS NULL AND amount > 0
        )
        ORDER BY recorded_at DESC, operation_id DESC
        LIMIT 1
      `);
      const revertEvent = this.db.prepare('UPDATE usage_events SET reverted_at = ? WHERE id = ?');
      const decrementAdjustment = this.db.prepare(`
        UPDATE usage_adjustments
        SET amount = CASE WHEN amount > 1 THEN amount - 1 ELSE amount END,
            reverted_at = CASE WHEN amount = 1 THEN ? ELSE reverted_at END
        WHERE id = ?
      `);
      try {
        for (const itemId of uniqueIds) {
          findLatest.bind([itemId, itemId]);
          if (findLatest.step()) {
            const operation = findLatest.getAsObject();
            if (operation.operation_type === 'event') {
              revertEvent.run([Date.now(), operation.operation_id]);
            } else {
              decrementAdjustment.run([Date.now(), operation.operation_id]);
            }
            count += 1;
          }
          findLatest.reset();
        }
      } finally {
        findLatest.free();
        revertEvent.free();
        decrementAdjustment.free();
      }
    });
    return { count };
  }

  getCounts(itemIds) {
    if (itemIds.length === 0) return new Map();
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = this.query(`
      SELECT eagle_item_id,
             SUM(usage_count) AS usage_count,
             SUM(undated_count) AS undated_count,
             MAX(last_used_at) AS last_used_at
      FROM (
        SELECT eagle_item_id, COUNT(*) AS usage_count, 0 AS undated_count,
               MAX(used_at) AS last_used_at
        FROM usage_events
        WHERE reverted_at IS NULL AND eagle_item_id IN (${placeholders})
        GROUP BY eagle_item_id
        UNION ALL
        SELECT eagle_item_id, SUM(amount) AS usage_count, SUM(amount) AS undated_count,
               NULL AS last_used_at
        FROM usage_adjustments
        WHERE reverted_at IS NULL AND eagle_item_id IN (${placeholders})
        GROUP BY eagle_item_id
      )
      GROUP BY eagle_item_id
    `, [...itemIds, ...itemIds]);
    return new Map(rows.map((row) => [row.eagle_item_id, row]));
  }

  getDailyActivity({ since, until = Date.now() } = {}) {
    return this.query(`
      SELECT strftime('%Y-%m-%d', used_at / 1000, 'unixepoch', 'localtime') AS day,
             COUNT(*) AS usage_count
      FROM usage_events
      WHERE reverted_at IS NULL AND used_at >= ? AND used_at <= ?
      GROUP BY day
      ORDER BY day
    `, [since ?? 0, until]);
  }

  getPeriodStats({ since = 0, until = Date.now(), includeUndated = false } = {}) {
    return this.query(`
      WITH dated AS (
        SELECT eagle_item_id, used_at
        FROM usage_events
        WHERE reverted_at IS NULL AND used_at >= ? AND used_at <= ?
      ), undated AS (
        SELECT eagle_item_id, amount
        FROM usage_adjustments
        WHERE reverted_at IS NULL AND ? = 1
      )
      SELECT (SELECT COUNT(*) FROM dated) + COALESCE((SELECT SUM(amount) FROM undated), 0) AS event_count,
             (SELECT COUNT(*) FROM (
                SELECT eagle_item_id FROM dated
                UNION
                SELECT eagle_item_id FROM undated
              )) AS item_count,
             (SELECT COUNT(DISTINCT strftime('%Y-%m-%d', used_at / 1000, 'unixepoch', 'localtime')) FROM dated) AS active_days,
             (SELECT MIN(used_at) FROM dated) AS first_used_at,
             (SELECT MAX(used_at) FROM dated) AS last_used_at,
             COALESCE((SELECT SUM(amount) FROM undated), 0) AS undated_count
    `, [since, until, includeUndated ? 1 : 0])[0];
  }

  getTimeSeries({ since = 0, until = Date.now(), granularity = 'day' } = {}) {
    const bucketExpressions = {
      day: "strftime('%Y-%m-%d', used_at / 1000, 'unixepoch', 'localtime')",
      week: "date(used_at / 1000, 'unixepoch', 'localtime', 'weekday 0', '-6 days')",
      month: "strftime('%Y-%m', used_at / 1000, 'unixepoch', 'localtime')",
      year: "strftime('%Y', used_at / 1000, 'unixepoch', 'localtime')",
    };
    const bucket = bucketExpressions[granularity];
    if (!bucket) throw new Error(`未対応の集計単位です: ${granularity}`);
    return this.query(`
      SELECT ${bucket} AS bucket,
             COUNT(*) AS usage_count,
             COUNT(DISTINCT eagle_item_id) AS item_count
      FROM usage_events
      WHERE reverted_at IS NULL AND used_at >= ? AND used_at <= ?
      GROUP BY bucket
      ORDER BY bucket
    `, [since, until]);
  }

  getWeekdayStats({ since = 0, until = Date.now() } = {}) {
    return this.query(`
      SELECT CAST(strftime('%w', used_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS weekday,
             COUNT(*) AS usage_count,
             COUNT(DISTINCT eagle_item_id) AS item_count
      FROM usage_events
      WHERE reverted_at IS NULL AND used_at >= ? AND used_at <= ?
      GROUP BY weekday
      ORDER BY weekday
    `, [since, until]);
  }

  getRanking({ since = 0, until = Date.now(), includeUndated = false, limit = 100 } = {}) {
    return this.query(`
      WITH totals AS (
        SELECT eagle_item_id, COUNT(*) AS usage_count, 0 AS undated_count,
               MAX(used_at) AS last_used_at
        FROM usage_events
        WHERE reverted_at IS NULL AND used_at >= ? AND used_at <= ?
        GROUP BY eagle_item_id
        UNION ALL
        SELECT eagle_item_id, SUM(amount) AS usage_count, SUM(amount) AS undated_count,
               NULL AS last_used_at
        FROM usage_adjustments
        WHERE reverted_at IS NULL AND ? = 1
        GROUP BY eagle_item_id
      )
      SELECT i.eagle_item_id, i.name, i.extension, i.thumbnail_url,
             SUM(t.usage_count) AS usage_count,
             SUM(t.undated_count) AS undated_count,
             MAX(t.last_used_at) AS last_used_at
      FROM totals t
      JOIN items i ON i.eagle_item_id = t.eagle_item_id
      GROUP BY t.eagle_item_id
      ORDER BY usage_count DESC, last_used_at DESC
      LIMIT ?
    `, [since, until, includeUndated ? 1 : 0, limit]);
  }

  getStats() {
    return this.getPeriodStats({ includeUndated: true });
  }

  query(sql, params = []) {
    this.reload(true);
    const statement = this.db.prepare(sql);
    const rows = [];
    try {
      statement.bind(params);
      while (statement.step()) rows.push(statement.getAsObject());
    } finally {
      statement.free();
    }
    return rows;
  }

  getFileSignature() {
    try {
      const stats = fs.statSync(this.filePath);
      return `${stats.mtimeMs}:${stats.size}`;
    } catch (_) {
      return null;
    }
  }

  reload(force = false) {
    const signature = this.getFileSignature();
    if (!signature || (!force && signature === this.fileSignature)) return;
    const replacement = new this.SQL.Database(fs.readFileSync(this.filePath));
    replacement.run('PRAGMA foreign_keys = ON');
    const oldDatabase = this.db;
    this.db = replacement;
    this.fileSignature = signature;
    oldDatabase.close();
  }

  acquireLock() {
    const lockPath = `${this.filePath}.lock`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const descriptor = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(descriptor, String(process.pid));
        return () => {
          fs.closeSync(descriptor);
          fs.rmSync(lockPath, { force: true });
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > 10_000) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch (_) {
          continue;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    throw new Error('データベースが別の画面で使用中です。少し待ってから再試行してください。');
  }

  persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, Buffer.from(this.db.export()));
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      fs.rmSync(this.filePath, { force: true });
      fs.renameSync(temporaryPath, this.filePath);
    }
    this.fileSignature = this.getFileSignature();
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}

module.exports = { UsageDatabase };
