import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLedger, settlementsAll } from '../src/ledger.js';
import { ingestSandbox, parseUsdcDecimal } from '../src/ingest/sandbox.js';

function fixtureDb() {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'sbx-')), 'sandbox.db');
  const db = new DatabaseSync(f);
  db.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT, title TEXT, price_usdc TEXT, network TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE settlements (id INTEGER PRIMARY KEY, ts TEXT, product_id INTEGER, amount_usdc TEXT, payer TEXT, tx_hash TEXT UNIQUE, network TEXT, facilitator TEXT, zar_value TEXT);
  `);
  db.prepare("INSERT INTO products (id, sku, title, price_usdc, network, created_at, updated_at) VALUES (1, 'soil-guide', 'Soil Guide', '1.00', 'base', '', '')").run();
  const ins = db.prepare('INSERT INTO settlements (ts, product_id, amount_usdc, payer, tx_hash, network, facilitator) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('2026-07-16T10:00:00.000Z', 1, '1.00', '0xbuyer1', '0xmain1', 'base', 'cdp');
  ins.run('2026-07-16T11:00:00.000Z', null, '0.02', '0xbuyer2', '0xmain2', 'base', 'cdp');
  ins.run('2026-07-15T09:00:00.000Z', 1, '0.01', '0xbuyer3', '0xtest1', 'base-sepolia', 'cdp');
  db.close();
  return f;
}

test('parseUsdcDecimal', () => {
  assert.equal(parseUsdcDecimal('1.00'), '1000000');
  assert.equal(parseUsdcDecimal('0.01'), '10000');
  assert.equal(parseUsdcDecimal('1'), '1000000');
  assert.equal(parseUsdcDecimal('1.5'), '1500000');
  assert.throws(() => parseUsdcDecimal('1,00'));
  assert.throws(() => parseUsdcDecimal(''));
});
test('ingests mainnet rows only, joins sku, testnet excluded', () => {
  const led = openLedger(':memory:');
  const cfg = { sandboxDbs: [fixtureDb()], wallets: ['0x' + 'AB'.repeat(20)] };
  const r = ingestSandbox(led, cfg);
  assert.equal(r.inserted, 2);
  assert.equal(r.errors.length, 0);
  const rows = settlementsAll(led);
  assert.equal(rows.length, 2);
  const attributed = rows.find((x) => x.tx_hash === '0xmain1');
  assert.equal(attributed.product_id, 'soil-guide');
  assert.equal(attributed.rail, 'x402');
  assert.equal(attributed.source, 'sandbox');
  assert.equal(attributed.ts, Math.floor(Date.parse('2026-07-16T10:00:00.000Z') / 1000));
  assert.equal(rows.find((x) => x.tx_hash === '0xmain2').product_id, null);
});
test('missing db collected as error, run continues', () => {
  const led = openLedger(':memory:');
  const cfg = { sandboxDbs: ['/nope/missing.db', fixtureDb()], wallets: ['0x' + 'ab'.repeat(20)] };
  const r = ingestSandbox(led, cfg);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /missing.db/);
  assert.equal(r.inserted, 2);
});
