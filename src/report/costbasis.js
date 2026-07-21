import { toCsv } from '../csv.js';
import { valuedRows } from './valuation.js';
import { periodLabel, banner, buildFooter, toolVersion, fmtUsdc } from './util.js';

export function costBasisReport(db, cfg, period, { incomplete = [], to = null } = {}) {
  const label = periodLabel(period, to);
  const rows = valuedRows(db, cfg, period, to);
  const csv = toCsv(
    ['date', 'asset', 'quantity', 'unit_price_usd', 'total_basis_usd'],
    rows.map((r) => [r.day, 'USDC', fmtUsdc(r.amount_atomic), r.usdcUsdRate, r.usd]),
  );
  const md = banner(incomplete) +
    `# Cost-basis export — ${label}\n\n${rows.length} receipt lots, for the capital-gains side that is ` +
    `deliberately out of x402-books' scope. Carry this CSV into your CGT tool or hand it to your accountant. ` +
    `Those tools expect their own column sets, so expect to map columns rather than import as-is.\n` +
    buildFooter(db, cfg, { period: label, version: toolVersion() });
  return { md, csv };
}
