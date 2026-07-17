import { toCsv } from '../csv.js';
import { valuedRows } from './valuation.js';
import { roundHalfUp, banner, buildFooter, toolVersion, ytdMonths } from './util.js';

export function packZa(db, cfg, period, { incomplete = [] } = {}) {
  const monthly = ytdMonths(period).map((m) => {
    const rows = valuedRows(db, cfg, m);
    return { month: m, count: rows.length, fiat: roundHalfUp(rows.reduce((t, r) => t + r.fiat, 0)) };
  });
  const cur = monthly.at(-1);
  const ytd = roundHalfUp(monthly.reduce((t, m) => t + m.fiat, 0));
  const md = banner(incomplete) +
    `# ZA provisional tax pack — ${period}\n\n` +
    `Gross x402 revenue income, ${cfg.baseCurrency}, income recognized at receipt (SARS revenue treatment — ` +
    `provisional taxpayer gross income). Disposal/CGT on later USDC conversion is OUT of scope — use the cost-basis export.\n\n` +
    '| Month | Settlements | Gross income |\n|---|---:|---:|\n' +
    monthly.map((m) => `| ${m.month} | ${m.count} | ${m.fiat.toFixed(2)} |`).join('\n') +
    `\n\n- **Period (${period}): ${cur.fiat.toFixed(2)} ${cfg.baseCurrency}**\n- **YTD (calendar): ${ytd.toFixed(2)} ${cfg.baseCurrency}**\n` +
    `\nNote: IRP6 uses tax-year (Mar-Feb) periods; calendar YTD shown — filter the valuation CSV for exact IRP6 windows.\n` +
    buildFooter(db, cfg, { period, version: toolVersion() });
  const csv = toCsv(['month', 'settlements', `gross_income_${cfg.baseCurrency.toLowerCase()}`],
    monthly.map((m) => [m.month, m.count, m.fiat.toFixed(2)]));
  return { md, csv };
}
