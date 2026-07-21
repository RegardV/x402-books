import { toCsv } from '../csv.js';
import { fmtUsdc, mdCell, selectRows, periodLabel, banner, buildFooter, toolVersion } from './util.js';

export function revenueReport(db, cfg, period, { incomplete = [], to = null } = {}) {
  const label = periodLabel(period, to);
  const rows = selectRows(db, period, to, cfg.timezone);
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.product_id ?? '(unattributed)'} ${r.endpoint ?? ''} ${r.chain}`;
    const g = groups.get(key) ?? { product: r.product_id ?? '(unattributed)', endpoint: r.endpoint ?? '', chain: r.chain, count: 0, gross: 0n, fees: 0n };
    g.count++;
    g.gross += BigInt(r.amount_atomic);
    g.fees += BigInt(r.facilitator_fee_atomic ?? 0);
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => (a.gross === b.gross ? 0 : a.gross < b.gross ? 1 : -1));
  const tot = list.reduce((t, g) => ({ count: t.count + g.count, gross: t.gross + g.gross, fees: t.fees + g.fees }), { count: 0, gross: 0n, fees: 0n });

  const header = '| Product | Endpoint | Chain | Settlements | Gross USDC | Fees USDC | Net USDC |';
  const sep = '|---|---|---|---:|---:|---:|---:|';
  const line = (g) => `| ${mdCell(g.product)} | ${mdCell(g.endpoint)} | ${g.chain} | ${g.count} | ${fmtUsdc(g.gross)} | ${fmtUsdc(g.fees)} | ${fmtUsdc(g.gross - g.fees)} |`;
  const md = banner(incomplete) +
    `# Revenue statement — ${label}\n\n` +
    [header, sep, ...list.map(line), `| **TOTAL** | | | **${tot.count}** | **${fmtUsdc(tot.gross)}** | **${fmtUsdc(tot.fees)}** | **${fmtUsdc(tot.gross - tot.fees)}** |`].join('\n') +
    '\n' + buildFooter(db, cfg, { period: label, version: toolVersion() });

  const csv = toCsv(
    ['product', 'endpoint', 'chain', 'settlements', 'gross_usdc', 'fees_usdc', 'net_usdc'],
    [...list.map((g) => [g.product, g.endpoint, g.chain, g.count, fmtUsdc(g.gross), fmtUsdc(g.fees), fmtUsdc(g.gross - g.fees)]),
     ['TOTAL', '', '', tot.count, fmtUsdc(tot.gross), fmtUsdc(tot.fees), fmtUsdc(tot.gross - tot.fees)]],
  );
  return { md, csv };
}
