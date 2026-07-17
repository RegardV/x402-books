import { toCsv } from '../csv.js';
import { valuedRows } from './valuation.js';
import { roundHalfUp, banner, buildFooter, toolVersion } from './util.js';

export function journalReport(db, cfg, period, { incomplete = [] } = {}) {
  const rows = valuedRows(db, cfg, period);
  const groups = new Map(); // key: day + product
  for (const r of rows) {
    const key = `${r.day} ${r.product_id ?? '(unattributed)'}`;
    const g = groups.get(key) ?? { day: r.day, product: r.product_id ?? '(unattributed)', fiat: 0, feeFiat: 0 };
    g.fiat = roundHalfUp(g.fiat + r.fiat);
    const feeUsdc = Number(BigInt(r.facilitator_fee_atomic ?? 0)) / 1e6;
    g.feeFiat = roundHalfUp(g.feeFiat + roundHalfUp(feeUsdc * r.usdcUsdRate * r.usdFiatRate));
    groups.set(key, g);
  }
  const out = [];
  for (const g of [...groups.values()].sort((a, b) => a.day.localeCompare(b.day))) {
    out.push([g.day, `x402 sales - ${g.product}`, cfg.accounts.clearing, g.fiat.toFixed(2), '']);
    out.push([g.day, `x402 sales - ${g.product}`, cfg.accounts.revenue, '', g.fiat.toFixed(2)]);
    if (g.feeFiat > 0) {
      out.push([g.day, `facilitator fees - ${g.product}`, cfg.accounts.fees, g.feeFiat.toFixed(2), '']);
      out.push([g.day, `facilitator fees - ${g.product}`, cfg.accounts.clearing, '', g.feeFiat.toFixed(2)]);
    }
  }
  const csv = toCsv(['Date', 'Description', 'Account', 'Debit', 'Credit'], out);
  const md = banner(incomplete) +
    `# Journal (Xero/QuickBooks import) — ${period} (${cfg.baseCurrency})\n\n` +
    `${out.length} journal lines from ${rows.length} settlements (daily x product rollup).\n` +
    `Import the CSV; account names configurable in books.json accounts block.\n` +
    buildFooter(db, cfg, { period, version: toolVersion() });
  return { md, csv };
}
