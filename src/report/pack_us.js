import { toCsv } from '../csv.js';
import { valuedRows } from './valuation.js';
import { roundHalfUp, banner, buildFooter, toolVersion, ytdMonths } from './util.js';

export function packUs(db, cfg, period, { incomplete = [] } = {}) {
  const usdCfg = { ...cfg, baseCurrency: 'USD' };
  const monthly = ytdMonths(period).map((m) => {
    const rows = valuedRows(db, usdCfg, m);
    return { month: m, count: rows.length, usd: roundHalfUp(rows.reduce((t, r) => t + r.usd, 0)) };
  });
  const cur = monthly.at(-1);
  const ytd = roundHalfUp(monthly.reduce((t, m) => t + m.usd, 0));
  const md = banner(incomplete) +
    `# US income pack — ${period}\n\n` +
    `Ordinary income at receipt FMV (USD), Schedule C oriented. Self-employment tax and deductions are your ` +
    `accountant's domain; disposal/CGT on later USDC conversion is OUT of scope — use the cost-basis export (Form 8949 side).\n\n` +
    '| Month | Settlements | Gross income (USD) |\n|---|---:|---:|\n' +
    monthly.map((m) => `| ${m.month} | ${m.count} | ${m.usd.toFixed(2)} |`).join('\n') +
    `\n\n- **Period (${period}): ${cur.usd.toFixed(2)} USD**\n- **YTD (calendar): ${ytd.toFixed(2)} USD**\n` +
    buildFooter(db, cfg, { period, version: toolVersion() });
  const csv = toCsv(['month', 'settlements', 'gross_income_usd'], monthly.map((m) => [m.month, m.count, m.usd.toFixed(2)]));
  return { md, csv };
}
