import { toCsv } from '../csv.js';
import { valuedRows } from './valuation.js';
import { banner, buildFooter, toolVersion, fmtUsdc } from './util.js';

export function costBasisReport(db, cfg, period, { incomplete = [] } = {}) {
  const rows = valuedRows(db, cfg, period);
  const csv = toCsv(
    ['date', 'asset', 'quantity', 'unit_price_usd', 'total_basis_usd'],
    rows.map((r) => [r.day, 'USDC', fmtUsdc(r.amount_atomic), r.usdcUsdRate, r.usd]),
  );
  const md = banner(incomplete) +
    `# Cost-basis export — ${period}\n\n${rows.length} receipt lots. Import this CSV into your capital-gains tool ` +
    `(Koinly-class) — disposal/CGT tracking is deliberately out of x402-books' scope.\n` +
    buildFooter(db, cfg, { period, version: toolVersion() });
  return { md, csv };
}
