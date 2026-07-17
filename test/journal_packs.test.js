import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, upsertSettlement, putRate } from '../src/ledger.js';
import { journalReport } from '../src/report/journal.js';
import { packZa } from '../src/report/pack_za.js';
import { packUs } from '../src/report/pack_us.js';

const CFG = { timezone: 'UTC', baseCurrency: 'ZAR', jurisdiction: 'ZA', accounts: { revenue: 'x402 Revenue', clearing: 'USDC Clearing', fees: 'Facilitator Fees' } };
function seed(db) {
  const mk = (tx, iso, atomic, product, fee) => upsertSettlement(db, { tx_hash: tx, chain: 'base', ts: Math.floor(Date.parse(iso) / 1000), payer: 'p', payee: 'w', amount_atomic: atomic, source: 'sandbox', product_id: product, facilitator_fee_atomic: fee ?? null });
  mk('0x1', '2026-07-10T10:00:00Z', '1000000', 'soil-guide', '1000');
  mk('0x2', '2026-07-10T11:00:00Z', '20000', 'soil-guide');
  mk('0x3', '2026-06-05T10:00:00Z', '500000', 'ask');
  for (const d of ['2026-06-05', '2026-07-10']) {
    putRate(db, { day: d, pair: 'USDC/USD', rate: 1.0, provenance: 't' });
    putRate(db, { day: d, pair: 'USD/ZAR', rate: 18.0, provenance: 't' });
  }
}
test('journal balances: debits == credits', () => {
  const db = openLedger(':memory:');
  seed(db);
  const { csv } = journalReport(db, CFG, '2026-07');
  const lines = csv.trim().split('\r\n').slice(1).map((l) => l.split(','));
  const debit = lines.reduce((t, c) => t + Number(c[3] || 0), 0);
  const credit = lines.reduce((t, c) => t + Number(c[4] || 0), 0);
  assert.ok(debit > 0);
  assert.equal(debit.toFixed(2), credit.toFixed(2));
  assert.match(csv, /x402 Revenue/);
  assert.match(csv, /Facilitator Fees/);
});
test('packZa: period + YTD in ZAR', () => {
  const db = openLedger(':memory:');
  seed(db);
  const { md } = packZa(db, CFG, '2026-07');
  assert.match(md, /18\.36/);            // period: 1.02 USDC * 18
  assert.match(md, /27\.36/);            // YTD: 1.52 USDC * 18
  assert.match(md, /SARS/);
  assert.match(md, /provisional/i);
});
test('packUs: period + YTD in USD at receipt', () => {
  const db = openLedger(':memory:');
  seed(db);
  const { md } = packUs(db, { ...CFG, jurisdiction: 'US' }, '2026-07');
  assert.match(md, /1\.02/);
  assert.match(md, /1\.52/);
  assert.match(md, /Schedule C/);
});
test('journal: aggregate raw fees before rounding (regression)', () => {
  const db = openLedger(':memory:');
  const mk = (tx, atomic, fee) => upsertSettlement(db, { tx_hash: tx, chain: 'base', ts: Math.floor(Date.parse('2026-07-15T10:00:00Z') / 1000), payer: 'p', payee: 'w', amount_atomic: atomic, source: 'sandbox', product_id: 'test', facilitator_fee_atomic: fee });
  mk('0xa', '100000', '3000');
  mk('0xb', '100000', '3000');
  mk('0xc', '100000', '3000');
  putRate(db, { day: '2026-07-15', pair: 'USDC/USD', rate: 1.0, provenance: 't' });
  putRate(db, { day: '2026-07-15', pair: 'USD/ZAR', rate: 1.0, provenance: 't' });
  const { csv } = journalReport(db, CFG, '2026-07');
  // Three settlements, each 0.003 USDC fee * 1.0 * 1.0 = 0.003 ZAR per settlement
  // Individual: 0.003 -> rounds to 0.00
  // Aggregate raw: 0.009 -> rounds to 0.01
  assert.match(csv, /facilitator fees.*,0\.01,/);
});
