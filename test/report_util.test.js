import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsdc, roundHalfUp, dayInTz, periodRows, banner, mdCell, buildFooter } from '../src/report/util.js';
import { openLedger, upsertSettlement, putRate } from '../src/ledger.js';

test('fmtUsdc', () => {
  assert.equal(fmtUsdc('1000000'), '1.00');
  assert.equal(fmtUsdc('20000'), '0.02');
  assert.equal(fmtUsdc('1'), '0.000001');
  assert.equal(fmtUsdc('1500000'), '1.50');
  assert.equal(fmtUsdc('-500000'), '-0.50');
  assert.equal(fmtUsdc('-1500000'), '-1.50');
});
test('roundHalfUp', () => {
  assert.equal(roundHalfUp(1.005), 1.01);
  assert.equal(roundHalfUp(1.004), 1.0);
  assert.equal(roundHalfUp(18.204999, 2), 18.2);
});
test('dayInTz respects timezone', () => {
  const ts = Math.floor(Date.parse('2026-07-01T23:30:00Z') / 1000);
  assert.equal(dayInTz(ts, 'UTC'), '2026-07-01');
  assert.equal(dayInTz(ts, 'Africa/Johannesburg'), '2026-07-02'); // UTC+2
});
test('periodRows uses tz day attribution', () => {
  const db = openLedger(':memory:');
  const mk = (tx, iso) => upsertSettlement(db, { tx_hash: tx, chain: 'base', ts: Math.floor(Date.parse(iso) / 1000), payer: 'p', payee: 'w', amount_atomic: '1', source: 'onchain' });
  mk('0xa', '2026-06-30T23:00:00Z'); // 01:00 Jul 1 in Joburg -> in period
  mk('0xb', '2026-07-31T22:30:00Z'); // 00:30 Aug 1 in Joburg -> out
  mk('0xc', '2026-07-15T12:00:00Z');
  const rows = periodRows(db, '2026-07', 'Africa/Johannesburg');
  assert.deepEqual(rows.map((r) => r.tx_hash).sort(), ['0xa', '0xc']);
});
test('banner empty and populated', () => {
  assert.equal(banner([]), '');
  assert.match(banner([{ source: 'onchain', reason: 'boom' }]), /INCOMPLETE/);
  assert.match(banner([{ source: 'onchain', reason: 'boom' }]), /boom/);
});
test('mdCell escapes pipes', () => {
  assert.equal(mdCell('a|b'), 'a\\|b');
  assert.equal(mdCell('normal'), 'normal');
  assert.equal(mdCell('a|b|c'), 'a\\|b\\|c');
});
test('buildFooter includes rate provenance', () => {
  const db = openLedger(':memory:');
  putRate(db, { pair: 'USDC/USD', day: '2026-07-01', rate: '1.00', provenance: 'ccxt-kraken' });
  const footer = buildFooter(db, { timezone: 'UTC', baseCurrency: 'USD', accounts: {} }, { period: '2026-07', version: '0.1.0' });
  assert.match(footer, /via ccxt-kraken/);
});
