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
    if (version > 1) throw new Error(`未対応のデータベースバージョンです: ${version}`);
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
          note TEXT NOT NULL DEFAULT '',
          reverted_at INTEGER,
          FOREIGN KEY (eagle_item_id) REFERENCES items(eagle_item_id)
        );
        CREATE INDEX idx_usage_events_item_time
          ON usage_events(eagle_item_id, used_at);
        CREATE INDEX idx_usage_events_time
          ON usage_events(used_at);
        CREATE INDEX idx_usage_events_batch
          ON usage_events(batch_id);
        PRAGMA user_version = 1;
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

  recordUsage(items, note = '') {
    const uniqueItems = [...new Map(items.map((item) => [item.id, item])).values()];
    if (uniqueItems.length === 0) return { batchId: null, count: 0 };

    const now = Date.now();
    const batchId = crypto.randomUUID();
    this.transaction(() => {
      const upsert = this.db.prepare(`
        INSERT INTO items (
          eagle_item_id, name, extension, thumbnail_url, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(eagle_item_id) DO UPDATE SET
          name = excluded.name,
          extension = excluded.extension,
          thumbnail_url = excluded.thumbnail_url,
          last_seen_at = excluded.last_seen_at
      `);
      const insertEvent = this.db.prepare(`
        INSERT INTO usage_events (eagle_item_id, batch_id, used_at, note)
        VALUES (?, ?, ?, ?)
      `);
      try {
        for (const item of uniqueItems) {
          upsert.run([
            item.id,
            item.name || '',
            item.ext || '',
            item.thumbnailURL || '',
            now,
            now,
          ]);
          insertEvent.run([item.id, batchId, now, note]);
        }
      } finally {
        upsert.free();
        insertEvent.free();
      }
    });
    return { batchId, count: uniqueItems.length };
  }

  decrementUsage(itemIds) {
    const uniqueIds = [...new Set(itemIds)];
    if (uniqueIds.length === 0) return { count: 0 };

    let count = 0;
    this.transaction(() => {
      const findLatest = this.db.prepare(`
        SELECT id FROM usage_events
        WHERE eagle_item_id = ? AND reverted_at IS NULL
        ORDER BY used_at DESC, id DESC
        LIMIT 1
      `);
      const revert = this.db.prepare('UPDATE usage_events SET reverted_at = ? WHERE id = ?');
      try {
        for (const itemId of uniqueIds) {
          findLatest.bind([itemId]);
          if (findLatest.step()) {
            revert.run([Date.now(), findLatest.getAsObject().id]);
            count += 1;
          }
          findLatest.reset();
        }
      } finally {
        findLatest.free();
        revert.free();
      }
    });
    return { count };
  }

  getCounts(itemIds) {
    if (itemIds.length === 0) return new Map();
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = this.query(`
      SELECT eagle_item_id, COUNT(*) AS usage_count, MAX(used_at) AS last_used_at
      FROM usage_events
      WHERE reverted_at IS NULL AND eagle_item_id IN (${placeholders})
      GROUP BY eagle_item_id
    `, itemIds);
    return new Map(rows.map((row) => [row.eagle_item_id, row]));
  }

  getRanking({ since = null, limit = 100 } = {}) {
    const condition = since == null ? '' : 'AND e.used_at >= ?';
    const params = since == null ? [limit] : [since, limit];
    return this.query(`
      SELECT i.eagle_item_id, i.name, i.extension, i.thumbnail_url,
             COUNT(*) AS usage_count, MAX(e.used_at) AS last_used_at
      FROM usage_events e
      JOIN items i ON i.eagle_item_id = e.eagle_item_id
      WHERE e.reverted_at IS NULL ${condition}
      GROUP BY e.eagle_item_id
      ORDER BY usage_count DESC, last_used_at DESC
      LIMIT ?
    `, params);
  }

  getStats() {
    return this.query(`
      SELECT COUNT(*) AS event_count,
             COUNT(DISTINCT eagle_item_id) AS item_count,
             MAX(used_at) AS last_used_at
      FROM usage_events
      WHERE reverted_at IS NULL
    `)[0];
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
