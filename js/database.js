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
    this.migrate();
    if (!bytes) this.persist();
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
    }
  }

  transaction(action) {
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

  undoLastBatch() {
    const rows = this.query(`
      SELECT batch_id, MAX(used_at) AS used_at, COUNT(*) AS event_count
      FROM usage_events
      WHERE reverted_at IS NULL
      GROUP BY batch_id
      ORDER BY used_at DESC, MAX(id) DESC
      LIMIT 1
    `);
    if (rows.length === 0) return null;

    const batch = rows[0];
    this.transaction(() => {
      this.db.run(
        'UPDATE usage_events SET reverted_at = ? WHERE batch_id = ? AND reverted_at IS NULL',
        [Date.now(), batch.batch_id],
      );
    });
    return { batchId: batch.batch_id, count: batch.event_count };
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

  exportBytes() {
    return Buffer.from(this.db.export());
  }

  replace(bytes) {
    const replacement = new this.SQL.Database(bytes);
    replacement.run('PRAGMA foreign_keys = ON');
    this.db.close();
    this.db = replacement;
    this.migrate();
    this.persist();
  }

  persist() {
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, this.exportBytes());
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      fs.rmSync(this.filePath, { force: true });
      fs.renameSync(temporaryPath, this.filePath);
    }
  }

  close() {
    if (!this.db) return;
    this.persist();
    this.db.close();
    this.db = null;
  }
}

module.exports = { UsageDatabase };
