const DDL = [
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    period_days REAL,
    traffic_limit_bytes INTEGER,
    used_bytes INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    disabled_reason TEXT,
    expires_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS accounts_enabled_idx ON accounts(enabled, expires_at)',
  `CREATE TABLE IF NOT EXISTS proxy_candidates (
    id TEXT PRIMARY KEY,
    uri TEXT NOT NULL,
    exit_ip TEXT,
    healthy INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_checked INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    ip_hash TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`
];

const SCHEMA_VERSION = '1';
const readyByDatabase = new WeakMap();

export function ensureSchema(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') throw new Error('D1 database binding DB is required');
  let ready = readyByDatabase.get(db);
  if (!ready) {
    ready = (async () => {
      await db.batch(DDL.map((statement) => db.prepare(statement)));
      await db.prepare(`INSERT OR IGNORE INTO app_meta(key, value, updated_at) VALUES('schema_version', ?, ?)`)
        .bind(SCHEMA_VERSION, Date.now()).run();
      await db.prepare(`INSERT OR IGNORE INTO app_settings(key, value, updated_at) VALUES('ws_path', ?, ?)`)
        .bind('/ws', Date.now()).run();
    })();
    readyByDatabase.set(db, ready);
  }
  return ready;
}
