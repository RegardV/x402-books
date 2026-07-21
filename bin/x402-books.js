#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, ConfigError } from '../src/config.js';
import { openLedger, statusSummary, settlementsAll } from '../src/ledger.js';
import { ensureRates, RateError } from '../src/rates.js';
import { ingestOnchain } from '../src/ingest/onchain.js';
import { ingestSandbox } from '../src/ingest/sandbox.js';
import { dayInTz, periodRows, ytdMonths, monthsInRange, toolVersion } from '../src/report/util.js';
import { revenueReport } from '../src/report/revenue.js';
import { valuationReport } from '../src/report/valuation.js';
import { costBasisReport } from '../src/report/costbasis.js';
import { journalReport } from '../src/report/journal.js';
import { packZa } from '../src/report/pack_za.js';
import { packUs } from '../src/report/pack_us.js';

const USAGE = `x402-books v${toolVersion()} — accountant-ready reports for x402 sellers (realandworks.com)

Usage:
  x402-books init
  x402-books sync   [--config F] [--from-block N] [--skip-onchain] [--stale-rates-ok]
  x402-books report --period YYYY-MM [--to YYYY-MM] [--out DIR] [--config F] [--no-sync] [--skip-onchain] [--stale-rates-ok]
  x402-books status [--config F]
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-onchain' || a === '--stale-rates-ok' || a === '--no-sync') args.flags[a.slice(2)] = true;
    else if (a.startsWith('--')) args.flags[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function doSync(db, cfg, flags) {
  const incomplete = [];
  if (!flags['skip-onchain']) {
    try {
      const r = await ingestOnchain(db, cfg, { fromBlock: flags['from-block'] ? parseInt(flags['from-block'], 10) : null });
      for (const w of r.warnings) console.warn(`warning: ${w}`);
      console.log(`onchain: +${r.inserted} inserted, ${r.updated} updated (head ${r.toBlock})`);
    } catch (e) {
      incomplete.push({ source: e.source ?? 'onchain', reason: e.message });
    }
  }
  const sb = ingestSandbox(db, cfg);
  console.log(`sandbox: +${sb.inserted} inserted, ${sb.updated} updated`);
  incomplete.push(...sb.errors.map((e) => ({ source: e.source, reason: e.message })));
  return incomplete;
}

async function ensurePeriodRates(db, cfg, period, flags) {
  const to = flags.to || null;
  const anchor = to ?? period;
  const rangeMonths = to ? monthsInRange(period, to) : [period];
  const taxMonths = cfg.jurisdiction === 'NONE' ? [] : ytdMonths(anchor);
  const months = [...new Set([...rangeMonths, ...taxMonths])];
  const days = [...new Set(months.flatMap((m) => periodRows(db, m, cfg.timezone).map((r) => dayInTz(r.ts, cfg.timezone))))];
  try {
    await ensureRates(db, { days, baseCurrency: cfg.baseCurrency, staleOk: !!flags['stale-rates-ok'] });
    return [];
  } catch (e) {
    if (e instanceof RateError) return [{ source: 'rates', reason: e.message }];
    throw e;
  }
}

export async function runCli(argv) {
  const { _: [cmd], flags } = parseArgs(argv);
  try {
    if (cmd === 'init') {
      if (existsSync('books.json')) {
        console.log('books.json already exists — not touching it.');
        return 0;
      }
      writeFileSync('books.json', readFileSync(new URL('../books.json.example', import.meta.url)));
      console.log('wrote books.json — edit wallets/currency/jurisdiction, then: x402-books report --period YYYY-MM');
      return 0;
    }
    if (!['sync', 'report', 'status'].includes(cmd)) {
      console.error(USAGE);
      return 2;
    }
    if (cmd === 'report' && (!flags.period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(flags.period))) {
      console.error('report requires --period YYYY-MM\n' + USAGE);
      return 2;
    }
    if (cmd === 'report' && flags.to && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(flags.to) || flags.to < flags.period)) {
      console.error('--to must be YYYY-MM and >= --period (range is period..to)\n' + USAGE);
      return 2;
    }
    const cfg = loadConfig(flags.config ?? 'books.json');
    const db = openLedger(cfg.dataDir);

    if (cmd === 'status') {
      const s = statusSummary(db);
      console.log(JSON.stringify({ version: toolVersion(), wallets: cfg.wallets, ...s }, null, 2));
      return 0;
    }
    if (cmd === 'sync') {
      const incomplete = await doSync(db, cfg, flags);
      const days = [...new Set(settlementsAll(db).map((r) => dayInTz(r.ts, cfg.timezone)))];
      try {
        await ensureRates(db, { days, baseCurrency: cfg.baseCurrency, staleOk: !!flags['stale-rates-ok'] });
      } catch (e) {
        if (!(e instanceof RateError)) throw e;
        incomplete.push({ source: 'rates', reason: e.message });
      }
      for (const e of incomplete) console.error(`INCOMPLETE ${e.source}: ${e.reason}`);
      return incomplete.length ? 1 : 0;
    }
    const period = flags.period;
    const incomplete = [];
    if (!flags['no-sync']) incomplete.push(...await doSync(db, cfg, flags));
    incomplete.push(...await ensurePeriodRates(db, cfg, period, flags));

    const to = flags.to || null;
    const anchor = to ?? period; // tax packs are YTD as-of the latest month requested
    const outDir = path.join(flags.out ?? 'reports', to ? `${period}_${to}` : period);
    mkdirSync(outDir, { recursive: true });
    const jobs = [
      ['revenue', () => revenueReport(db, cfg, period, { incomplete, to })],
      ['valuation', () => valuationReport(db, cfg, period, { incomplete, to })],
      ['journal', () => journalReport(db, cfg, period, { incomplete, to })],
      ['costbasis', () => costBasisReport(db, cfg, period, { incomplete, to })],
    ];
    if (cfg.jurisdiction === 'ZA') jobs.push(['pack_za', () => packZa(db, cfg, anchor, { incomplete })]);
    if (cfg.jurisdiction === 'US') jobs.push(['pack_us', () => packUs(db, cfg, anchor, { incomplete })]);
    // Two-pass generation: if a report job itself surfaces a new failure
    // (e.g. RateError), regenerate so EVERY report carries the final banner —
    // nothing is written to disk until the incomplete list is stable.
    let results = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = incomplete.length;
      results = [];
      for (const [name, fn] of jobs) {
        try {
          results.push([name, fn()]);
        } catch (e) {
          if (!(e instanceof RateError)) throw e;
          if (!incomplete.some((i) => i.source === 'rates' && i.reason === e.message)) {
            incomplete.push({ source: 'rates', reason: e.message });
          }
          results.push([name, null]);
        }
      }
      if (incomplete.length === before) break;
    }
    for (const [name, r] of results) {
      if (r === null) {
        writeFileSync(path.join(outDir, `${name}.md`), `> WARNING: INCOMPLETE — report could not be generated (see rates errors)\n`);
        console.error(`INCOMPLETE ${name}: not generated`);
        continue;
      }
      writeFileSync(path.join(outDir, `${name}.md`), r.md);
      writeFileSync(path.join(outDir, `${name}.csv`), r.csv);
      console.log(`wrote ${path.join(outDir, name)}.{md,csv}`);
    }
    for (const e of incomplete) console.error(`INCOMPLETE ${e.source}: ${e.reason}`);
    return incomplete.length ? 1 : 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(await runCli(process.argv.slice(2)));
}
