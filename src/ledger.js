import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL DEFAULT 0,
  chain TEXT NOT NULL,
  block_number INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  payer TEXT NOT NULL,
  payee TEXT NOT NULL,
  token TEXT NOT NULL DEFAULT 'USDC',
  amount_atomic TEXT NOT NULL,
  source TEXT NOT NULL,
  product_id TEXT,
  endpoint TEXT,
  rail TEXT,
  facilitator_fee_atomic TEXT,
  UNIQUE (tx_hash, chain)
);
CREATE INDEX IF NOT EXISTS idx_settlements_ts ON settlements (ts);
CREATE TABLE IF NOT EXISTS watermarks (
  source TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rates (
  day TEXT NOT NULL,
  pair TEXT NOT NULL,
  rate REAL NOT NULL,
  fetched_at INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  PRIMARY KEY (day, pair)
);
`;

export function openLedger(dataDir) {
  let file = dataDir;
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'books.db');
  }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

const UPSERT = `
INSERT INTO settlements (tx_hash, log_index, chain, block_number, ts, payer, payee, token, amount_atomic, source, product_id, endpoint, rail, facilitator_fee_atomic)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (tx_hash, chain) DO UPDATE SET
  block_number = CASE WHEN excluded.source = 'onchain' THEN excluded.block_number ELSE block_number END,
  ts           = CASE WHEN excluded.source = 'onchain' THEN excluded.ts ELSE ts END,
  payer        = CASE WHEN excluded.source = 'onchain' THEN excluded.payer ELSE payer END,
  log_index    = CASE WHEN excluded.source = 'onchain' THEN excluded.log_index ELSE log_index END,
  source       = CASE WHEN excluded.source = 'onchain' OR source = 'onchain' THEN 'onchain' ELSE source END,
  payee        = CASE WHEN excluded.source = 'onchain' THEN excluded.payee ELSE payee END,
  amount_atomic = CASE WHEN excluded.source = 'onchain' THEN excluded.amount_atomic ELSE amount_atomic END,
  token        = CASE WHEN excluded.source = 'onchain' THEN excluded.token ELSE token END,
  product_id   = COALESCE(product_id, excluded.product_id),
  endpoint     = COALESCE(endpoint, excluded.endpoint),
  rail         = COALESCE(rail, excluded.rail),
  facilitator_fee_atomic = COALESCE(facilitator_fee_atomic, excluded.facilitator_fee_atomic)
`;

export function upsertSettlement(db, row) {
  const r = {
    log_index: 0, block_number: 0, token: 'USDC',
    product_id: null, endpoint: null, rail: null, facilitator_fee_atomic: null,
    ...row,
  };
  const exists = db.prepare('SELECT 1 FROM settlements WHERE tx_hash = ? AND chain = ?').get(r.tx_hash, r.chain);
  db.prepare(UPSERT).run(
    r.tx_hash, r.log_index, r.chain, r.block_number, r.ts, r.payer, r.payee,
    r.token, r.amount_atomic, r.source, r.product_id, r.endpoint, r.rail, r.facilitator_fee_atomic,
  );
  return exists ? 'updated' : 'inserted';
}

export function getWatermark(db, key) {
  const row = db.prepare('SELECT value FROM watermarks WHERE source = ?').get(key);
  return row ? row.value : null;
}
export function setWatermark(db, key, value) {
  db.prepare('INSERT INTO watermarks (source, value) VALUES (?, ?) ON CONFLICT (source) DO UPDATE SET value = excluded.value').run(key, String(value));
}
export function putRate(db, { day, pair, rate, provenance }) {
  db.prepare('INSERT OR REPLACE INTO rates (day, pair, rate, fetched_at, provenance) VALUES (?, ?, ?, ?, ?)')
    .run(day, pair, rate, Math.floor(Date.now() / 1000), provenance);
}
export function getRate(db, day, pair) {
  const row = db.prepare('SELECT rate, provenance FROM rates WHERE day = ? AND pair = ?').get(day, pair);
  return row ?? null;
}
export function settlementsAll(db) {
  return db.prepare('SELECT * FROM settlements ORDER BY ts, id').all();
}
export function settlementsBetween(db, fromTs, toTsExcl) {
  return db.prepare('SELECT * FROM settlements WHERE ts >= ? AND ts < ? ORDER BY ts, id').all(fromTs, toTsExcl);
}
export function statusSummary(db) {
  const settlements = db.prepare('SELECT COUNT(*) c FROM settlements').get().c;
  const bySource = {};
  for (const r of db.prepare('SELECT source, COUNT(*) c FROM settlements GROUP BY source').all()) bySource[r.source] = r.c;
  const watermarks = db.prepare('SELECT source, value FROM watermarks ORDER BY source').all();
  const rateDays = db.prepare('SELECT COUNT(*) c FROM rates').get().c;
  return { settlements, bySource, watermarks, rateDays };
}
