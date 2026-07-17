import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, putRate, getRate } from '../src/ledger.js';
import { ensureRates, RateError } from '../src/rates.js';

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    for (const [pat, resp] of handlers) {
      if (String(url).includes(pat)) return { ok: true, status: 200, json: async () => resp };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}
const CG = ['api.coingecko.com', { prices: [[Date.UTC(2026, 6, 1, 23) , 0.9998], [Date.UTC(2026, 6, 2, 23), 1.0001], [Date.UTC(2026, 6, 3, 23), 0.9999]] }];
const FX = ['api.frankfurter.app', { rates: { '2026-07-01': { ZAR: 18.0 }, '2026-07-03': { ZAR: 18.2 } } }];

test('fetches, caches, forward-fills fiat weekend', async () => {
  const db = openLedger(':memory:');
  const f = fakeFetch([CG, FX]);
  const r = await ensureRates(db, { days: ['2026-07-01', '2026-07-02', '2026-07-03'], baseCurrency: 'ZAR', fetchFn: f });
  assert.equal(getRate(db, '2026-07-02', 'USDC/USD').rate, 1.0001);
  assert.equal(getRate(db, '2026-07-02', 'USD/ZAR').rate, 18.0);           // carried
  assert.match(getRate(db, '2026-07-02', 'USD/ZAR').provenance, /carried/);
  assert.equal(getRate(db, '2026-07-03', 'USD/ZAR').rate, 18.2);
  assert.ok(r.fetched > 0);
});
test('cache hit never refetches', async () => {
  const db = openLedger(':memory:');
  for (const d of ['2026-07-01']) {
    putRate(db, { day: d, pair: 'USDC/USD', rate: 1, provenance: 'x' });
    putRate(db, { day: d, pair: 'USD/ZAR', rate: 18, provenance: 'x' });
  }
  const f = fakeFetch([]);
  await ensureRates(db, { days: ['2026-07-01'], baseCurrency: 'ZAR', fetchFn: f });
  assert.equal(f.calls.length, 0);
});
test('USD base uses identity, no fiat fetch', async () => {
  const db = openLedger(':memory:');
  const f = fakeFetch([CG]);
  await ensureRates(db, { days: ['2026-07-01'], baseCurrency: 'USD', fetchFn: f });
  assert.equal(getRate(db, '2026-07-01', 'USD/USD').rate, 1);
  assert.ok(!f.calls.some((u) => u.includes('frankfurter')));
});
test('USDC gap without staleOk throws RateError; with staleOk carries', async () => {
  const db = openLedger(':memory:');
  const cgGap = ['api.coingecko.com', { prices: [[Date.UTC(2026, 6, 1, 23), 1.0]] }];
  await assert.rejects(
    () => ensureRates(db, { days: ['2026-07-01', '2026-07-02'], baseCurrency: 'USD', fetchFn: fakeFetch([cgGap]) }),
    RateError,
  );
  const db2 = openLedger(':memory:');
  await ensureRates(db2, { days: ['2026-07-01', '2026-07-02'], baseCurrency: 'USD', fetchFn: fakeFetch([cgGap]), staleOk: true });
  assert.match(getRate(db2, '2026-07-02', 'USDC/USD').provenance, /carried/);
});
test('fiat gap before any known rate throws RateError', async () => {
  const db = openLedger(':memory:');
  const cgOk = ['api.coingecko.com', { prices: [[Date.UTC(2026, 6, 1, 23), 0.9998], [Date.UTC(2026, 6, 2, 23), 1.0001]] }];
  const fxEmpty = ['api.frankfurter.app', { rates: {} }];
  await assert.rejects(
    () => ensureRates(db, { days: ['2026-07-01', '2026-07-02'], baseCurrency: 'ZAR', fetchFn: fakeFetch([cgOk, fxEmpty]) }),
    RateError,
  );
});
test('retries once on network error then succeeds', async () => {
  const db = openLedger(':memory:');
  let callCount = 0;
  const retryFetch = async (url) => {
    callCount++;
    if (callCount === 1 && url.includes('coingecko')) {
      throw new Error('network timeout');
    }
    for (const [pat, resp] of [CG, FX]) {
      if (url.includes(pat)) return { ok: true, status: 200, json: async () => resp };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const r = await ensureRates(db, { days: ['2026-07-01'], baseCurrency: 'ZAR', fetchFn: retryFetch });
  assert.equal(getRate(db, '2026-07-01', 'USDC/USD').rate, 0.9998);
  assert.equal(getRate(db, '2026-07-01', 'USD/ZAR').rate, 18.0);
  assert.ok(r.fetched > 0);
});
