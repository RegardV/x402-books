import { readFileSync } from 'node:fs';
import { settlementsBetween, statusSummary } from '../ledger.js';

export function toolVersion() {
  return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
}
export function fmtUsdc(atomic) {
  const a = BigInt(atomic);
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const int = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(6, '0');
  frac = frac.replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return (neg ? '-' : '') + `${int}.${frac}`;
}
export function mdCell(v) {
  return String(v).replaceAll('|', '\\|');
}
export function roundHalfUp(x, dp = 2) {
  const f = 10 ** dp;
  return Math.round((x + Number.EPSILON) * f) / f;
}
export function dayInTz(tsSec, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsSec * 1000));
}
export function periodRows(db, period, tz) {
  const [y, m] = period.split('-').map(Number);
  const fromTs = Math.floor(Date.UTC(y, m - 1, 1) / 1000) - 14 * 3600;
  const toTs = Math.floor(Date.UTC(y, m, 1) / 1000) + 14 * 3600;
  return settlementsBetween(db, fromTs, toTs).filter((r) => dayInTz(r.ts, tz).startsWith(period));
}
export function banner(incomplete) {
  if (!incomplete || incomplete.length === 0) return '';
  const lines = incomplete.map((e) => `> - **${e.source}**: ${e.reason}`).join('\n');
  return `> WARNING: ⚠ **INCOMPLETE** — some data sources failed; totals below may be understated.\n${lines}\n\n`;
}
export function buildFooter(db, cfg, { period, version }) {
  const s = statusSummary(db);
  const src = Object.entries(s.bySource).map(([k, v]) => `${k}: ${v} rows`).join(', ') || 'none';
  const wm = s.watermarks.map((w) => `${w.source}@${w.value}`).join(', ') || 'none';
  const rates = db.prepare('SELECT pair, COUNT(*) c, MIN(day) d1, MAX(day) d2, (SELECT provenance FROM rates r2 WHERE r2.pair = r1.pair ORDER BY day DESC LIMIT 1) prov FROM rates r1 GROUP BY pair ORDER BY pair').all()
    .map((r) => `${r.pair}: ${r.c} days (${r.d1}..${r.d2}, via ${r.prov})`).join(', ') || 'none';
  return [
    '', '---',
    `- Period: ${period} · Timezone: ${cfg.timezone} (all date attribution)`,
    `- Ledger sources: ${src}`,
    `- Watermarks: ${wm}`,
    `- Rates cached: ${rates}`,
    `- Generated: ${new Date().toISOString()} · x402-books v${version}`,
    '',
  ].join('\n');
}
