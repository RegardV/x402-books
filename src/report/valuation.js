import { toCsv } from '../csv.js';
import { getRate } from '../ledger.js';
import { RateError } from '../rates.js';
import { fmtUsdc, roundHalfUp, dayInTz, periodRows, banner, buildFooter, toolVersion } from './util.js';

export function valuedRows(db, cfg, period) {
  const fiatPair = `USD/${cfg.baseCurrency}`;
  return periodRows(db, period, cfg.timezone).map((r) => {
    const day = dayInTz(r.ts, cfg.timezone);
    const usdcUsd = getRate(db, day, 'USDC/USD');
    const usdFiat = cfg.baseCurrency === 'USD' ? { rate: 1, provenance: 'identity' } : getRate(db, day, fiatPair);
    if (!usdcUsd || !usdFiat) throw new RateError(`missing rate for ${day} (run sync, or --stale-rates-ok)`);
    const usdc = Number(BigInt(r.amount_atomic)) / 1e6;
    const usd = roundHalfUp(usdc * usdcUsd.rate);
    const fiat = roundHalfUp(usdc * usdcUsd.rate * usdFiat.rate);
    return { ...r, day, usdc, usd, fiat, usdcUsdRate: usdcUsd.rate, usdFiatRate: usdFiat.rate };
  });
}

export function valuationReport(db, cfg, period, { incomplete = [] } = {}) {
  const rows = valuedRows(db, cfg, period);
  const usdTotal = roundHalfUp(rows.reduce((t, r) => t + r.usd, 0));
  const fiatTotal = roundHalfUp(rows.reduce((t, r) => t + r.fiat, 0));
  const cur = cfg.baseCurrency;
  const csv = toCsv(
    ['day', 'tx_hash', 'product', 'amount_usdc', 'usdc_usd_rate', 'usd_value', `usd_${cur.toLowerCase()}_rate`, `${cur.toLowerCase()}_value`],
    rows.map((r) => [r.day, r.tx_hash, r.product_id ?? '(unattributed)', fmtUsdc(r.amount_atomic), r.usdcUsdRate, r.usd, r.usdFiatRate, r.fiat]),
  );
  const byDay = new Map();
  for (const r of rows) byDay.set(r.day, roundHalfUp((byDay.get(r.day) ?? 0) + r.fiat));
  const md = banner(incomplete) +
    `# Fiat valuation — ${period} (${cur})\n\n` +
    '| Day | Settlements | Value |\n|---|---:|---:|\n' +
    [...byDay.entries()].map(([d, v]) => `| ${d} | ${rows.filter((r) => r.day === d).length} | ${v.toFixed(2)} |`).join('\n') +
    `\n| **TOTAL** | **${rows.length}** | **${fiatTotal.toFixed(2)}** |\n` +
    `\nUSD total (income basis): ${usdTotal.toFixed(2)}\n` +
    buildFooter(db, cfg, { period, version: toolVersion() });
  return { md, csv, usdTotal, fiatTotal };
}
