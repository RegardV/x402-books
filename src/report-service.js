// Shared report pipeline: build a per-request in-memory ledger for one buyer-named
// wallet, ingest on-chain (public) data only, value it, and return the report bundle.
// Used by both entrypoints — server/backend.js (unpaid, behind the sandbox proxy)
// and server/serve.js (standalone, x402-paid). Stateless: nothing persists.
import { loadConfig } from './config.js';
import { openLedger } from './ledger.js';
import { ingestOnchain } from './ingest/onchain.js';
import { ensureRates, RateError } from './rates.js';
import { dayInTz, periodRows, ytdMonths, monthsInRange } from './report/util.js';
import { revenueReport } from './report/revenue.js';
import { valuationReport } from './report/valuation.js';
import { costBasisReport } from './report/costbasis.js';
import { journalReport } from './report/journal.js';
import { packZa } from './report/pack_za.js';
import { packUs } from './report/pack_us.js';

const pick = (r) => ({ md: r.md, csv: r.csv });

// reqData: { wallet, period, jurisdiction, baseCurrency, to? } (already validated).
// `to` (optional, YYYY-MM >= period) turns revenue/valuation/journal/costbasis into a
// month range [period..to]. Tax packs stay year-to-date, anchored on the range end.
export async function runReport({ wallet, period, jurisdiction, baseCurrency, to = null }, { basescanKey = '', fromBlock = null } = {}) {
  const cfg = loadConfig({
    wallets: [wallet], baseCurrency, jurisdiction,
    sandboxDbs: [], basescanApiKey: basescanKey, timezone: 'UTC', dataDir: ':memory:',
  });
  const db = openLedger(':memory:');
  const incomplete = [];
  // ponytail: full-history chain scan per request, in-memory ledger discarded after.
  // No cross-request cache. Fine at positioning-service volume; add a shared read
  // cache keyed by (wallet, headBlock), or set fromBlock to the wallet's first block,
  // if this ever gets real traffic.
  await ingestOnchain(db, cfg, { fromBlock });

  const anchor = to ?? period; // tax packs are YTD as-of the latest month requested
  const rangeMonths = to ? monthsInRange(period, to) : [period];
  const taxMonths = jurisdiction === 'NONE' ? [] : ytdMonths(anchor);
  const months = [...new Set([...rangeMonths, ...taxMonths])];
  const days = [...new Set(months.flatMap((m) => periodRows(db, m, cfg.timezone).map((r) => dayInTz(r.ts, cfg.timezone))))];
  try {
    await ensureRates(db, { days, baseCurrency: cfg.baseCurrency, staleOk: true });
  } catch (e) {
    if (e instanceof RateError) incomplete.push({ source: 'rates', reason: e.message });
    else throw e;
  }

  const reports = {
    revenue: pick(revenueReport(db, cfg, period, { incomplete, to })),
    valuation: pick(valuationReport(db, cfg, period, { incomplete, to })),
    journal: pick(journalReport(db, cfg, period, { incomplete, to })),
    costbasis: pick(costBasisReport(db, cfg, period, { incomplete, to })),
  };
  if (jurisdiction === 'ZA') reports.pack_za = pick(packZa(db, cfg, anchor, { incomplete }));
  if (jurisdiction === 'US') reports.pack_us = pick(packUs(db, cfg, anchor, { incomplete }));

  db.close?.();
  return { reports, incomplete };
}
