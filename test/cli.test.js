import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLedger, putRate } from '../src/ledger.js';
import { runCli } from '../bin/x402-books.js';

function setup({ jurisdiction = 'ZA' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
  const dataDir = path.join(dir, 'data');
  const sbx = path.join(dir, 'sandbox.db');
  const s = new DatabaseSync(sbx);
  s.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT, title TEXT, price_usdc TEXT, network TEXT, created_at TEXT, updated_at TEXT);
          CREATE TABLE settlements (id INTEGER PRIMARY KEY, ts TEXT, product_id INTEGER, amount_usdc TEXT, payer TEXT, tx_hash TEXT UNIQUE, network TEXT, facilitator TEXT, zar_value TEXT);`);
  s.prepare("INSERT INTO products (id, sku, title, price_usdc, network, created_at, updated_at) VALUES (1,'soil-guide','g','1.00','base','','')").run();
  s.prepare("INSERT INTO settlements (ts, product_id, amount_usdc, payer, tx_hash, network) VALUES ('2026-07-10T10:00:00.000Z',1,'1.00','0xb','0xe2e1','base')").run();
  s.close();
  const cfgFile = path.join(dir, 'books.json');
  writeFileSync(cfgFile, JSON.stringify({ wallets: ['0x' + 'ab'.repeat(20)], sandboxDbs: [sbx], baseCurrency: 'ZAR', jurisdiction, timezone: 'UTC', dataDir }));
  const led = openLedger(dataDir);
  putRate(led, { day: '2026-07-10', pair: 'USDC/USD', rate: 1, provenance: 't' });
  putRate(led, { day: '2026-07-10', pair: 'USD/ZAR', rate: 18, provenance: 't' });
  led.close();
  return { dir, cfgFile, dataDir };
}

test('report end-to-end: sandbox-only sync, all files, exit 0', async () => {
  const { dir, cfgFile } = setup();
  const out = path.join(dir, 'reports');
  const code = await runCli(['report', '--period', '2026-07', '--config', cfgFile, '--out', out, '--skip-onchain']);
  assert.equal(code, 0);
  for (const f of ['revenue.md', 'revenue.csv', 'valuation.csv', 'journal.csv', 'costbasis.csv', 'pack_za.md']) {
    assert.ok(existsSync(path.join(out, '2026-07', f)), `missing ${f}`);
  }
  const md = readFileSync(path.join(out, '2026-07', 'revenue.md'), 'utf8');
  assert.match(md, /soil-guide/);
  assert.doesNotMatch(md, /INCOMPLETE/);
});
test('missing sandbox db -> INCOMPLETE banner + exit 1', async () => {
  const { dir, cfgFile } = setup();
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.sandboxDbs.push('/nope/gone.db');
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const out = path.join(dir, 'r2');
  const code = await runCli(['report', '--period', '2026-07', '--config', cfgFile, '--out', out, '--skip-onchain']);
  assert.equal(code, 1);
  assert.match(readFileSync(path.join(out, '2026-07', 'revenue.md'), 'utf8'), /INCOMPLETE/);
});
test('config error -> exit 2', async () => {
  assert.equal(await runCli(['report', '--period', '2026-07', '--config', '/nope/books.json']), 2);
});
test('usage error -> exit 2', async () => {
  const { cfgFile } = setup();
  assert.equal(await runCli(['report', '--config', cfgFile]), 2); // no --period
  assert.equal(await runCli(['bogus-command']), 2);
});
test('init writes and refuses to clobber', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'init-'));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(await runCli(['init']), 0);
    assert.ok(existsSync('books.json'));
    writeFileSync('books.json', '{"custom":1}');
    assert.equal(await runCli(['init']), 0);
    assert.match(readFileSync('books.json', 'utf8'), /custom/);
  } finally {
    process.chdir(prev);
  }
});
