import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, upsertSettlement, putRate } from '../src/ledger.js';
import { valuationReport, valuedRows } from '../src/report/valuation.js';
import { costBasisReport } from '../src/report/costbasis.js';
import { RateError } from '../src/rates.js';

const CFG = { timezone: 'UTC', baseCurrency: 'ZAR', jurisdiction: 'ZA', accounts: {} };
function seed(db) {
  upsertSettlement(db, { tx_hash: '0x1', chain: 'base', ts: Math.floor(Date.parse('2026-07-10T10:00:00Z') / 1000), payer: 'p', payee: 'w', amount_atomic: '1000000', source: 'sandbox', product_id: 'soil-guide' });
  putRate(db, { day: '2026-07-10', pair: 'USDC/USD', rate: 0.9998, provenance: 't' });
  putRate(db, { day: '2026-07-10', pair: 'USD/ZAR', rate: 18.0, provenance: 't' });
}
test('values line at day rates, rounds half-up, totals = sum of lines', () => {
  const db = openLedger(':memory:');
  seed(db);
  const { csv, md, usdTotal, fiatTotal } = valuationReport(db, CFG, '2026-07');
  assert.equal(usdTotal, 1.0);            // 0.9998 -> 1.00 line-rounded
  assert.equal(fiatTotal, 18.0);          // 0.9998*18.0=17.9964 -> 18.00
  assert.match(csv, /0x1,soil-guide,1.00,0.9998,1,18,18/);
  assert.match(md, /18\.00/);
});
test('valuedRows exposes day and fiat for reuse', () => {
  const db = openLedger(':memory:');
  seed(db);
  const [r] = valuedRows(db, CFG, '2026-07');
  assert.equal(r.day, '2026-07-10');
  assert.equal(r.fiat, 18.0);
});
test('USD base needs no USD/USD rate row', () => {
  const db = openLedger(':memory:');
  seed(db);
  const [r] = valuedRows(db, { ...CFG, baseCurrency: 'USD' }, '2026-07');
  assert.equal(r.fiat, r.usd);
});
test('missing rate throws RateError', () => {
  const db = openLedger(':memory:');
  upsertSettlement(db, { tx_hash: '0x2', chain: 'base', ts: Math.floor(Date.parse('2026-07-11T10:00:00Z') / 1000), payer: 'p', payee: 'w', amount_atomic: '1000000', source: 'sandbox' });
  assert.throws(() => valuationReport(db, CFG, '2026-07'), RateError);
});
test('costbasis lots in USD', () => {
  const db = openLedger(':memory:');
  seed(db);
  const { csv } = costBasisReport(db, CFG, '2026-07');
  assert.match(csv, /2026-07-10,USDC,1.00,0.9998,1/);
});
