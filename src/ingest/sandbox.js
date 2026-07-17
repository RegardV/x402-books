import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { upsertSettlement } from '../ledger.js';
import { IngestError } from './onchain.js';

export function parseUsdcDecimal(s) {
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s)) throw new Error(`bad USDC decimal: ${JSON.stringify(s)}`);
  const [int, frac = ''] = s.split('.');
  return (BigInt(int) * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6))).toString();
}

export function ingestSandbox(db, cfg) {
  let inserted = 0, updated = 0;
  const errors = [];
  for (const file of cfg.sandboxDbs) {
    if (!existsSync(file)) {
      errors.push(new IngestError(`sandbox:${file}`, `sandbox db not found: ${file}`));
      continue;
    }
    let sdb;
    try {
      sdb = new DatabaseSync(file, { readOnly: true });
      const rows = sdb.prepare(`
        SELECT s.ts, s.amount_usdc, s.payer, s.tx_hash, s.facilitator, p.sku
        FROM settlements s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.network = 'base'
      `).all();
      for (const r of rows) {
        const ts = Math.floor(Date.parse(r.ts) / 1000);
        if (!Number.isFinite(ts)) {
          errors.push(new IngestError(`sandbox:${file}`, `unparseable ts on tx ${r.tx_hash}: ${r.ts}`));
          continue;
        }
        const action = upsertSettlement(db, {
          tx_hash: r.tx_hash, chain: 'base', ts,
          payer: r.payer, payee: cfg.wallets[0].toLowerCase(),
          amount_atomic: parseUsdcDecimal(r.amount_usdc),
          source: 'sandbox', product_id: r.sku ?? null, rail: 'x402',
        });
        if (action === 'inserted') inserted++; else updated++;
      }
    } catch (e) {
      errors.push(e instanceof IngestError ? e : new IngestError(`sandbox:${file}`, `${file}: ${e.message}`));
    } finally {
      try { sdb?.close(); } catch { /* already closed */ }
    }
  }
  return { inserted, updated, errors };
}
