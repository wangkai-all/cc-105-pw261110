// SQLite 持久化层（node:sqlite，零依赖）。只存脱敏后的数据。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.HAR_EXTRACTOR_DATA || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'har-extractor.db'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  entry_count INTEGER NOT NULL,
  sanitize_config TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  started_at TEXT,
  time_ms INTEGER,
  method TEXT, url TEXT, host TEXT, path TEXT, endpoint TEXT,
  query_json TEXT NOT NULL DEFAULT '[]',
  request_headers_json TEXT NOT NULL DEFAULT '[]',
  post_params_json TEXT NOT NULL DEFAULT '[]',
  post_text TEXT, post_text_state TEXT DEFAULT 'none',
  status INTEGER, status_text TEXT, failed INTEGER DEFAULT 0,
  mime_type TEXT,
  response_headers_json TEXT NOT NULL DEFAULT '[]',
  body_state TEXT NOT NULL, body_text TEXT, body_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_import ON entries(import_id, endpoint);
CREATE TABLE IF NOT EXISTS schemes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  config TEXT NOT NULL,
  fingerprint TEXT
);
CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scheme_id INTEGER REFERENCES schemes(id) ON DELETE SET NULL,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  stats TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS dataset_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  entry_id INTEGER,
  row_idx INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rows_dataset ON dataset_rows(dataset_id);
CREATE TABLE IF NOT EXISTS dataset_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  entry_id INTEGER,
  reason TEXT NOT NULL,
  detail TEXT
);
`);

const J = JSON.stringify;
const P = JSON.parse;

export const store = {
  createImport({ name, source, sanitizeConfig, warnings, entries }) {
    const tx = db.prepare('INSERT INTO imports (name, source, entry_count, sanitize_config, warnings) VALUES (?,?,?,?,?)');
    const info = tx.run(name, source, entries.length, J(sanitizeConfig), J(warnings));
    const importId = Number(info.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO entries
      (import_id, idx, started_at, time_ms, method, url, host, path, endpoint, query_json, request_headers_json,
       post_params_json, post_text, post_text_state, status, status_text, failed, mime_type, response_headers_json,
       body_state, body_text, body_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const e of entries) {
      ins.run(importId, e.idx, e.startedAt, e.timeMs, e.method, e.url, e.host, e.path, e.endpoint,
        J(e.query), J(e.requestHeaders), J(e.postParams), e.postText, e.postTextState,
        e.status, e.statusText, e.failed ? 1 : 0, e.mimeType, J(e.responseHeaders),
        e.bodyState, e.bodyText, e.bodyHash);
    }
    return importId;
  },

  listImports() {
    return db.prepare(`SELECT i.id, i.name, i.source, i.created_at, i.entry_count, i.warnings,
      (SELECT COUNT(*) FROM datasets d WHERE d.import_id = i.id) AS dataset_count
      FROM imports i ORDER BY i.id DESC`).all()
      .map((r) => ({ ...r, warnings: P(r.warnings) }));
  },

  getImport(id) {
    const r = db.prepare('SELECT * FROM imports WHERE id=?').get(id);
    if (!r) return null;
    return { ...r, sanitize_config: P(r.sanitize_config), warnings: P(r.warnings) };
  },

  deleteImport(id) {
    db.prepare('DELETE FROM entries WHERE import_id=?').run(id);
    db.prepare('DELETE FROM imports WHERE id=?').run(id);
  },

  listEntries(importId, { endpoint, status, state, q } = {}) {
    let sql = `SELECT id, idx, started_at, time_ms, method, url, host, path, endpoint, query_json,
      status, status_text, failed, mime_type, body_state, body_hash, post_text_state
      FROM entries WHERE import_id=?`;
    const args = [importId];
    if (endpoint) { sql += ' AND endpoint=?'; args.push(endpoint); }
    if (status) { sql += ' AND status=?'; args.push(Number(status)); }
    if (state === 'failed') sql += ' AND failed=1';
    if (state === 'missing') sql += " AND body_state='missing'";
    if (state === 'ok') sql += " AND body_state='ok' AND failed=0";
    if (q) { sql += ' AND url LIKE ?'; args.push(`%${q}%`); }
    sql += ' ORDER BY started_at, idx';
    return db.prepare(sql).all(...args).map((r) => ({ ...r, query: P(r.query_json), query_json: undefined }));
  },

  getEntry(id) {
    const r = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
    if (!r) return null;
    return {
      ...r,
      query: P(r.query_json), requestHeaders: P(r.request_headers_json),
      postParams: P(r.post_params_json), responseHeaders: P(r.response_headers_json),
      body: r.body_text ? tryParse(r.body_text) : null,
    };
  },

  entriesForEndpoint(importId, endpoint) {
    return db.prepare(`SELECT * FROM entries WHERE import_id=? AND endpoint=? ORDER BY started_at, idx`)
      .all(importId, endpoint)
      .map((r) => ({
        ...r,
        failed: !!r.failed,
        bodyState: r.body_state,
        bodyHash: r.body_hash,
        statusText: r.status_text,
        mimeType: r.mime_type,
        query: P(r.query_json),
        postParams: P(r.post_params_json),
        body: r.body_text ? tryParse(r.body_text) : null,
      }));
  },

  allEntries(importId) {
    return db.prepare('SELECT * FROM entries WHERE import_id=? ORDER BY started_at, idx').all(importId)
      .map((r) => ({
        ...r,
        failed: !!r.failed,
        bodyHash: r.body_hash,
        query: P(r.query_json),
        postParams: P(r.post_params_json),
      }));
  },

  saveScheme({ id, name, config, fingerprint }) {
    if (id) {
      db.prepare('UPDATE schemes SET name=?, config=?, fingerprint=?, updated_at=datetime(\'now\') WHERE id=?')
        .run(name, J(config), fingerprint ? J(fingerprint) : null, id);
      return id;
    }
    const info = db.prepare('INSERT INTO schemes (name, config, fingerprint) VALUES (?,?,?)')
      .run(name, J(config), fingerprint ? J(fingerprint) : null);
    return Number(info.lastInsertRowid);
  },

  listSchemes() {
    return db.prepare('SELECT id, name, created_at, updated_at, config, fingerprint FROM schemes ORDER BY id DESC').all()
      .map((r) => ({ ...r, config: P(r.config), fingerprint: r.fingerprint ? P(r.fingerprint) : null }));
  },

  getScheme(id) {
    const r = db.prepare('SELECT * FROM schemes WHERE id=?').get(id);
    if (!r) return null;
    return { ...r, config: P(r.config), fingerprint: r.fingerprint ? P(r.fingerprint) : null };
  },

  deleteScheme(id) { db.prepare('DELETE FROM schemes WHERE id=?').run(id); },

  createDataset({ name, schemeId, importId, stats, rows, failures }) {
    const info = db.prepare('INSERT INTO datasets (name, scheme_id, import_id, stats) VALUES (?,?,?,?)')
      .run(name, schemeId ?? null, importId, J(stats));
    const datasetId = Number(info.lastInsertRowid);
    const insRow = db.prepare('INSERT INTO dataset_rows (dataset_id, entry_id, row_idx, data) VALUES (?,?,?,?)');
    rows.forEach((r, i) => insRow.run(datasetId, r.entryId ?? null, i, J(r.data)));
    const insFail = db.prepare('INSERT INTO dataset_failures (dataset_id, entry_id, reason, detail) VALUES (?,?,?,?)');
    for (const f of failures) insFail.run(datasetId, f.entryId ?? null, f.reason, f.detail ?? null);
    return datasetId;
  },

  listDatasets() {
    return db.prepare(`SELECT d.id, d.name, d.created_at, d.stats, d.import_id, d.scheme_id,
      i.name AS import_name, s.name AS scheme_name,
      (SELECT COUNT(*) FROM dataset_rows r WHERE r.dataset_id=d.id) AS row_count,
      (SELECT COUNT(*) FROM dataset_failures f WHERE f.dataset_id=d.id) AS failure_count
      FROM datasets d JOIN imports i ON i.id=d.import_id LEFT JOIN schemes s ON s.id=d.scheme_id
      ORDER BY d.id DESC`).all()
      .map((r) => ({ ...r, stats: P(r.stats) }));
  },

  getDataset(id, offset = 0, limit = 200) {
    const d = db.prepare('SELECT * FROM datasets WHERE id=?').get(id);
    if (!d) return null;
    const rows = db.prepare('SELECT entry_id, row_idx, data FROM dataset_rows WHERE dataset_id=? ORDER BY row_idx LIMIT ? OFFSET ?')
      .all(id, limit, offset)
      .map((r) => ({ entryId: r.entry_id, rowIdx: r.row_idx, data: P(r.data) }));
    const total = db.prepare('SELECT COUNT(*) c FROM dataset_rows WHERE dataset_id=?').get(id).c;
    const failures = db.prepare(`SELECT f.entry_id, f.reason, f.detail, e.method, e.url, e.status
      FROM dataset_failures f LEFT JOIN entries e ON e.id=f.entry_id WHERE f.dataset_id=?`).all(id);
    return { ...d, stats: P(d.stats), rows, total, failures };
  },

  datasetRows(id) {
    return db.prepare('SELECT data FROM dataset_rows WHERE dataset_id=? ORDER BY row_idx').all(id).map((r) => P(r.data));
  },

  deleteDataset(id) {
    db.prepare('DELETE FROM dataset_rows WHERE dataset_id=?').run(id);
    db.prepare('DELETE FROM dataset_failures WHERE dataset_id=?').run(id);
    db.prepare('DELETE FROM datasets WHERE id=?').run(id);
  },
};

function tryParse(s) { try { return JSON.parse(s); } catch { return null; } }
