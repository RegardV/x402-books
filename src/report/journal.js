import { toCsv } from '../csv.js';
import { valuedRows } from './valuation.js';
import { roundHalfUp, periodLabel, banner, buildFooter, toolVersion } from './util.js';

export function journalReport(db, cfg, period, { incomplete = [], to = null } = {}) {
  const label = periodLabel(period, to);
  const rows = valuedRows(db, cfg, period, to);
  const groups = new Map(); // key: day + product
  for (const r of rows) {
    const key = `${r.day} ${r.product_id ?? '(unattributed)'}`;
    const g = groups.get(key) ?? { day: r.day, product: r.product_id ?? '(unattributed)', fiat: 0, feeFiatRaw: 0 };
    g.fiat = roundHalfUp(g.fiat + r.fiat);
    const feeUsdc = Number(BigInt(r.facilitator_fee_atomic ?? 0)) / 1e6;
    g.feeFiatRaw = g.feeFiatRaw + feeUsdc * r.usdcUsdRate * r.usdFiatRate;
    groups.set(key, g);
  }
  const out = [];
  for (const g of [...groups.values()].sort((a, b) => a.day.localeCompare(b.day))) {
    out.push([g.day, `x402 sales - ${g.product}`, cfg.accounts.clearing, g.fiat.toFixed(2), '']);
    out.push([g.day, `x402 sales - ${g.product}`, cfg.accounts.revenue, '', g.fiat.toFixed(2)]);
    const feeFiat = roundHalfUp(g.feeFiatRaw);
    if (feeFiat > 0) {
      out.push([g.day, `facilitator fees - ${g.product}`, cfg.accounts.fees, feeFiat.toFixed(2), '']);
      out.push([g.day, `facilitator fees - ${g.product}`, cfg.accounts.clearing, '', feeFiat.toFixed(2)]);
    }
  }
  const csv = toCsv(['Date', 'Description', 'Account', 'Debit', 'Credit'], out);
  const md = banner(incomplete) +
    `# Journal (double-entry) — ${label} (${cfg.baseCurrency})\n\n` +
    `${out.length} journal lines from ${rows.length} settlements (daily x product rollup), debits = credits.\n` +
    `Generic journal shape — maps into Xero or QuickBooks with light column work, but is not a native\n` +
    `import file for either. Account names are configurable in the books.json accounts block.\n` +
    buildFooter(db, cfg, { period: label, version: toolVersion() });
  return { md, csv };
}
