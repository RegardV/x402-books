import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, upsertSettlement, getWatermark, setWatermark, putRate, getRate, settlementsBetween, statusSummary } from '../src/ledger.js';

const base = { tx_hash: '0xabc', chain: 'base', ts: 1752700000, payer: '0xp', payee: '0xw', amount_atomic: '1000000', source: 'onchain' };

test('insert then re-insert is idempotent', () => {
  const db = openLedger(':memory:');
  assert.equal(upsertSettlement(db, base), 'inserted');
  assert.equal(upsertSettlement(db, base), 'updated');
  assert.equal(settlementsBetween(db, 0, 2e12).length, 1);
});
test('onchain-first then sandbox enriches product, keeps onchain ts', () => {
  const db = openLedger(':memory:');
  upsertSettlement(db, { ...base, block_number: 99 });
  upsertSettlement(db, { ...base, ts: 1752700555, source: 'sandbox', product_id: 'soil-guide', rail: 'x402' });
  const [r] = settlementsBetween(db, 0, 2e12);
  assert.equal(r.product_id, 'soil-guide');
  assert.equal(r.rail, 'x402');
  assert.equal(r.ts, 1752700000);       // onchain ts kept
  assert.equal(r.source, 'onchain');
  assert.equal(r.block_number, 99);
});
test('sandbox-first then onchain upgrades source/ts/block, keeps product', () => {
  const db = openLedger(':memory:');
  upsertSettlement(db, { ...base, ts: 1752700555, block_number: 0, source: 'sandbox', product_id: 'soil-guide' });
  upsertSettlement(db, { ...base, block_number: 42, source: 'onchain' });
  const [r] = settlementsBetween(db, 0, 2e12);
  assert.equal(r.source, 'onchain');
  assert.equal(r.block_number, 42);
  assert.equal(r.ts, 1752700000);
  assert.equal(r.product_id, 'soil-guide');
});
test('watermarks and rates round-trip', () => {
  const db = openLedger(':memory:');
  assert.equal(getWatermark(db, 'k'), null);
  setWatermark(db, 'k', '123');
  setWatermark(db, 'k', '456');
  assert.equal(getWatermark(db, 'k'), '456');
  assert.equal(getRate(db, '2026-07-01', 'USD/ZAR'), null);
  putRate(db, { day: '2026-07-01', pair: 'USD/ZAR', rate: 18.02, provenance: 'ecb 2026-07-01' });
  assert.equal(getRate(db, '2026-07-01', 'USD/ZAR').rate, 18.02);
});
test('settlementsBetween bounds and order', () => {
  const db = openLedger(':memory:');
  upsertSettlement(db, { ...base, tx_hash: '0x1', ts: 100 });
  upsertSettlement(db, { ...base, tx_hash: '0x2', ts: 200 });
  upsertSettlement(db, { ...base, tx_hash: '0x3', ts: 300 });
  const rows = settlementsBetween(db, 100, 300);
  assert.deepEqual(rows.map((r) => r.tx_hash), ['0x1', '0x2']);
});
test('statusSummary counts', () => {
  const db = openLedger(':memory:');
  upsertSettlement(db, base);
  setWatermark(db, 'onchain:base:0xw', '9');
  putRate(db, { day: '2026-07-01', pair: 'USDC/USD', rate: 1, provenance: 'x' });
  const s = statusSummary(db);
  assert.equal(s.settlements, 1);
  assert.equal(s.bySource.onchain, 1);
  assert.equal(s.watermarks.length, 1);
  assert.equal(s.rateDays, 1);
});
test('onchain overrides amount/payee/token, keeps sandbox product_id', () => {
  const db = openLedger(':memory:');
  // Sandbox-first with incorrect amount and payee
  upsertSettlement(db, { ...base, tx_hash: '0xdef', ts: 1752700555, source: 'sandbox', amount_atomic: '1000000', payee: '0xw', product_id: 'soil-guide' });
  // Onchain lands with correct amount and payee
  upsertSettlement(db, { ...base, tx_hash: '0xdef', amount_atomic: '999999', payee: '0xcorrect', source: 'onchain' });
  const [r] = settlementsBetween(db, 0, 2e12);
  assert.equal(r.amount_atomic, '999999');  // onchain amount
  assert.equal(r.payee, '0xcorrect');       // onchain payee
  assert.equal(r.source, 'onchain');
  assert.equal(r.product_id, 'soil-guide');  // sandbox product retained
  assert.equal(r.token, 'USDC');  // default token (both rows use default)
});
