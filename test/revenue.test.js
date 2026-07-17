import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, upsertSettlement } from '../src/ledger.js';
import { revenueReport } from '../src/report/revenue.js';

function seed(db) {
  const mk = (tx, atomic, product, fee = null) => upsertSettlement(db, {
    tx_hash: tx, chain: 'base', ts: Math.floor(Date.parse('2026-07-10T10:00:00Z') / 1000),
    payer: 'p', payee: 'w', amount_atomic: atomic, source: 'sandbox', product_id: product,
    rail: 'x402', facilitator_fee_atomic: fee,
  });
  mk('0x1', '1000000', 'soil-guide', '1000');
  mk('0x2', '20000', 'soil-guide');
  mk('0x3', '500000', null); // unattributed
}
const CFG = { timezone: 'UTC', baseCurrency: 'USD', accounts: { revenue: 'x402 Revenue', clearing: 'USDC Clearing', fees: 'Facilitator Fees' } };

test('groups by product, nets fees, totals reconcile', () => {
  const db = openLedger(':memory:');
  seed(db);
  const { md, csv } = revenueReport(db, CFG, '2026-07');
  assert.match(md, /soil-guide/);
  assert.match(md, /\(unattributed\)/);
  assert.match(md, /1\.02/);            // soil-guide gross
  assert.match(md, /1\.52/);            // grand total gross
  assert.match(csv, /soil-guide,.*2,1.02/);
  assert.doesNotMatch(md, /INCOMPLETE/);
});
test('incomplete banner renders', () => {
  const db = openLedger(':memory:');
  seed(db);
  const { md } = revenueReport(db, CFG, '2026-07', { incomplete: [{ source: 'onchain', reason: 'explorer 500' }] });
  assert.match(md, /INCOMPLETE/);
});
