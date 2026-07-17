import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError, expandHome } from '../src/config.js';

function tmpConfig(obj) {
  const dir = mkdtempSync(path.join(tmpdir(), 'books-'));
  const f = path.join(dir, 'books.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}
const VALID = { wallets: ['0x' + 'a'.repeat(40)], baseCurrency: 'ZAR', jurisdiction: 'ZA', timezone: 'UTC' };

test('valid config loads with defaults filled', () => {
  const cfg = loadConfig(tmpConfig(VALID));
  assert.equal(cfg.baseCurrency, 'ZAR');
  assert.equal(cfg.chains.base.usdc, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.deepEqual(cfg.sandboxDbs, []);
  assert.equal(cfg.accounts.revenue, 'x402 Revenue');
  assert.ok(!cfg.dataDir.startsWith('~'));
});
test('missing file names the file and suggests init', () => {
  assert.throws(() => loadConfig('/nope/books.json'), (e) => e instanceof ConfigError && /init/.test(e.message));
});
test('bad wallet named in error', () => {
  assert.throws(() => loadConfig(tmpConfig({ ...VALID, wallets: ['0x123'] })), /wallets/);
});
test('empty wallets rejected', () => {
  assert.throws(() => loadConfig(tmpConfig({ ...VALID, wallets: [] })), /wallets/);
});
test('bad jurisdiction rejected', () => {
  assert.throws(() => loadConfig(tmpConfig({ ...VALID, jurisdiction: 'DE' })), /jurisdiction/);
});
test('bad currency rejected', () => {
  assert.throws(() => loadConfig(tmpConfig({ ...VALID, baseCurrency: 'zar' })), /baseCurrency/);
});
test('bad timezone rejected', () => {
  assert.throws(() => loadConfig(tmpConfig({ ...VALID, timezone: 'Mars/Olympus' })), /timezone/);
});
test('expandHome expands leading tilde', () => {
  assert.equal(expandHome('~/x'), path.join(homedir(), 'x'));
  assert.equal(expandHome('/abs/x'), '/abs/x');
});
