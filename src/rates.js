import { putRate, getRate } from './ledger.js';

export class RateError extends Error {
  constructor(msg) { super(msg); this.source = 'rates'; }
}

async function fetchJson(fetchFn, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetchFn(url);
    } catch (e) {
      if (attempt === 1) throw new RateError(`fetch failed: ${url}: ${e.message}`);
      continue;
    }
    if (res.ok) return res.json();
    if (attempt === 1 || (res.status !== 429 && res.status < 500)) {
      throw new RateError(`HTTP ${res.status} from ${url}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

export async function ensureRates(db, { days, baseCurrency, fetchFn = globalThis.fetch, staleOk = false }) {
  const sorted = [...new Set(days)].sort();
  if (sorted.length === 0) return { fetched: 0, carried: 0 };
  const fiatPair = `USD/${baseCurrency}`;
  let fetched = 0, carried = 0;

  // --- USDC/USD via CoinGecko range (one call for all missing days) ---
  const missingUsdc = sorted.filter((d) => !getRate(db, d, 'USDC/USD'));
  if (missingUsdc.length > 0) {
    const from = Math.floor(Date.parse(missingUsdc[0] + 'T00:00:00Z') / 1000) - 86400;
    const to = Math.floor(Date.parse(missingUsdc.at(-1) + 'T00:00:00Z') / 1000) + 2 * 86400;
    const data = await fetchJson(fetchFn, `https://api.coingecko.com/api/v3/coins/usd-coin/market_chart/range?vs_currency=usd&from=${from}&to=${to}`);
    const byDay = new Map();
    for (const [ms, price] of data.prices ?? []) byDay.set(utcDay(ms), price); // last wins
    let lastKnown = null;
    for (const d of sorted) {
      const cachedBefore = getRate(db, d, 'USDC/USD');
      if (cachedBefore) { lastKnown = { day: d, rate: cachedBefore.rate }; continue; }
      if (byDay.has(d)) {
        putRate(db, { day: d, pair: 'USDC/USD', rate: byDay.get(d), provenance: 'coingecko usd-coin market_chart' });
        lastKnown = { day: d, rate: byDay.get(d) };
        fetched++;
      } else if (staleOk && lastKnown) {
        putRate(db, { day: d, pair: 'USDC/USD', rate: lastKnown.rate, provenance: `coingecko (carried from ${lastKnown.day})` });
        carried++;
      } else {
        throw new RateError(`no USDC/USD rate for ${d} (use --stale-rates-ok to carry forward)`);
      }
    }
  }

  // --- USD/<base> ---
  if (baseCurrency === 'USD') {
    for (const d of sorted) {
      if (!getRate(db, d, 'USD/USD')) { putRate(db, { day: d, pair: 'USD/USD', rate: 1, provenance: 'identity' }); }
    }
    return { fetched, carried };
  }
  const missingFiat = sorted.filter((d) => !getRate(db, d, fiatPair));
  if (missingFiat.length > 0) {
    const data = await fetchJson(fetchFn, `https://api.frankfurter.app/${missingFiat[0]}..${missingFiat.at(-1)}?from=USD&to=${baseCurrency}`);
    const rates = data.rates ?? {};
    let lastKnown = null;
    for (const d of sorted) {
      const cachedBefore = getRate(db, d, fiatPair);
      if (cachedBefore) { lastKnown = { day: d, rate: cachedBefore.rate }; continue; }
      if (rates[d]?.[baseCurrency] !== undefined) {
        putRate(db, { day: d, pair: fiatPair, rate: rates[d][baseCurrency], provenance: `ecb/frankfurter ${d}` });
        lastKnown = { day: d, rate: rates[d][baseCurrency] };
        fetched++;
      } else if (lastKnown) {
        putRate(db, { day: d, pair: fiatPair, rate: lastKnown.rate, provenance: `ecb/frankfurter (carried from ${lastKnown.day})` });
        carried++;
      } else {
        throw new RateError(`no ${fiatPair} rate on or before ${d}`);
      }
    }
  }
  return { fetched, carried };
}
