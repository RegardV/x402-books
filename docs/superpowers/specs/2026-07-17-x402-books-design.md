# x402 Books — v1 Design Spec

**Date:** 2026-07-17 · **Status:** approved by owner (conversation, 2026-07-17)
**Repo:** `~/Documents/x402-books` → github.com/RegardV/x402-books (MIT, public after PII scan)
**Brand:** "x402-books by realandworks.com"

## Problem

x402 sellers earn micro-revenue (thousands of $0.01–$1.00 USDC settlements) across
chains and rails with zero accounting tooling. Facilitators settle but don't report.
Generic crypto-accounting tools (Koinly, Cryptio, …) price per transaction (breaks on
micropayment volume), see raw transfers without x402 semantics (which product, which
endpoint, gross vs fee), and QuickBooks itself only handles 2 decimal places.
Third-party validation: WorkOS's x402-vs-MPP comparison names "no accounting
reconciliation out of the box" as x402's gap.

## Product

Local-first, zero-runtime-dependency Node CLI. A seller points it at their payTo
wallet(s) and (optionally) their x402-sandbox install, runs `npx x402-books report`,
and gets accountant-ready output. Financial data never leaves the machine.

**Non-goals (v1):** hosted anything, accounts, Solana/Polygon ingesters, CDP
facilitator + Stripe importers, disposal/capital-gains tracking (we export a
cost-basis CSV for Koinly-class tools instead), multi-user.

## Toolchain

- Node ≥ 22.5 (dev machine: v24). Plain ESM JavaScript, no build step, no TypeScript.
- `node:sqlite` for the ledger, `node:test` for tests, global `fetch` for HTTP.
- **Zero runtime npm dependencies.** Hand-rolled argv parsing and CSV writer.
- Test style: golden-fixture TDD — synthetic chain data + fixture sandbox DB →
  snapshot-tested report output. Coverage target 80%+.

## Architecture

```
ingest → normalize (canonical ledger, SQLite) → report (pure functions)
```

New ingesters and new reports must never touch each other; the ledger is the only
interface between them.

### Repository layout

```
x402-books/
├── bin/x402-books.js        # CLI entry: argv parse, command dispatch
├── src/
│   ├── config.js            # load + validate books.json
│   ├── ledger.js            # sqlite open/migrate, upsert, query API
│   ├── rates.js             # daily fiat rates: fetch, cache, lookup
│   ├── csv.js               # minimal CSV writer (quoting, no deps)
│   ├── ingest/
│   │   ├── onchain.js       # Base USDC Transfer logs → ledger
│   │   └── sandbox.js       # x402-sandbox sqlite → enrich/insert ledger rows
│   └── report/
│       ├── revenue.js       # revenue statement (md + csv)
│       ├── valuation.js     # fiat valuation ledger (csv + md summary)
│       ├── journal.js       # Xero/QuickBooks journal csv (daily rollups)
│       ├── pack_za.js       # ZA provisional-tax income summary
│       ├── pack_us.js       # US Schedule-C-oriented income summary
│       └── costbasis.js     # cost-basis CSV export (receipt lots)
├── test/                    # node:test files + test/fixtures/
├── books.json.example
├── README.md
└── LICENSE (MIT)
```

## Config — `books.json`

```json
{
  "wallets": ["0xYourPayToAddress"],
  "chains": { "base": { "usdc": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
  "sandboxDbs": ["/home/user/x402-sandbox/sandbox.db"],
  "baseCurrency": "ZAR",
  "jurisdiction": "ZA",
  "timezone": "UTC",
  "basescanApiKey": "",
  "dataDir": "~/.x402-books",
  "accounts": {
    "revenue": "x402 Revenue",
    "clearing": "USDC Clearing",
    "fees": "Facilitator Fees"
  }
}
```

`accounts` is optional; the defaults shown are used when absent.

- `wallets` required, ≥1, each validated as 0x + 40 hex.
- `baseCurrency` ISO-4217; `jurisdiction` ∈ {ZA, US, NONE}; `timezone` IANA string,
  default UTC. Date attribution for ALL reports = settlement block timestamp
  converted to this timezone; every report footer states it.
- `dataDir` holds `books.db` and rate cache. `~` expanded.
- Validation fails fast with a clear message naming the bad field (no partial runs).

## Ledger schema (`books.db`)

```sql
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL DEFAULT 0,
  chain TEXT NOT NULL,             -- 'base'
  block_number INTEGER NOT NULL,
  ts INTEGER NOT NULL,             -- unix seconds (block timestamp)
  payer TEXT NOT NULL,
  payee TEXT NOT NULL,
  token TEXT NOT NULL,             -- 'USDC'
  amount_atomic TEXT NOT NULL,     -- integer string, 6dp USDC atomic units
  source TEXT NOT NULL,            -- 'onchain' | 'sandbox'
  product_id TEXT,                 -- from sandbox join
  endpoint TEXT,                   -- from sandbox join
  rail TEXT,                       -- 'x402' when known
  facilitator_fee_atomic TEXT,     -- integer string when known, else NULL
  UNIQUE (tx_hash, chain)
);
-- ponytail ceiling: one settlement per tx per chain. A tx carrying two USDC
-- transfers to the same wallet would record only one; ingester logs a warning.
-- Upgrade path: widen key to include log_index and teach the sandbox ingester
-- to join on-chain first.
CREATE TABLE IF NOT EXISTS watermarks (
  source TEXT PRIMARY KEY,         -- 'onchain:base:0xwallet'
  value TEXT NOT NULL              -- last scanned block number
);
CREATE TABLE IF NOT EXISTS rates (
  day TEXT NOT NULL,               -- YYYY-MM-DD (in report tz)
  pair TEXT NOT NULL,              -- 'USDC/USD', 'USD/ZAR'
  rate REAL NOT NULL,
  fetched_at INTEGER NOT NULL,
  provenance TEXT NOT NULL,        -- source URL/id
  PRIMARY KEY (day, pair)
);
```

- Amounts are **atomic-unit integer strings** end to end; conversion to decimal
  happens only at render time. No floats in money math (rates are the one exception,
  applied at render with explicit rounding to 2dp, ROUND_HALF_UP).
- Idempotency: upserts keyed on `(tx_hash, log_index, chain)`. A sandbox row for an
  existing on-chain settlement UPDATEs product/endpoint/rail/fee fields; it never
  duplicates. A sandbox settlement with no on-chain row yet inserts with
  `source='sandbox'` (later on-chain scan upgrades `source` to 'onchain').

## Ingesters

### `onchain` (universal)

- USDC `Transfer(address,address,uint256)` events **to** each configured wallet on
  Base. Topic0 = keccak of the signature; topic2 = wallet (padded).
- Primary: Blockscout-compatible API (`https://base.blockscout.com/api`), module
  `logs`, `action=getLogs`; optional Basescan key supported via config
  (`https://api.basescan.org/api`). Fallback: raw JSON-RPC `eth_getLogs` against
  `https://mainnet.base.org` in ≤10k-block windows.
- Incremental: per-wallet block watermark; re-runs are no-ops. `--from-block` flag
  for first-run bounding (default: block 2797222 — Base USDC contract deployment,
  2023-08; scanning earlier is pointless).
- Rate limits honored: ≤5 req/s, single retry with backoff on 429/5xx; on final
  failure raise a structured error (see Integrity).

### `sandbox` (deep)

- Reads each configured x402-sandbox SQLite (read-only). Real schema (verified
  2026-07-17): `settlements(ts TEXT-ISO, product_id FK, amount_usdc TEXT-decimal,
  payer, tx_hash UNIQUE, network, facilitator, zar_value)` joined to
  `products(sku, title, …)`. Mapping: ledger product_id = products.sku,
  rail='x402', chain=network, amount parsed by string math to 6dp atomic units.
  **Only mainnet rows (`network='base'`) are ingested** — testnet is noise in books.
- Missing/unreadable DB file → structured error naming the path; other DBs continue.
- Schema drift tolerated: reads by column name, ignores extras, errors clearly on
  missing required columns.

## Rates

- `USDC/USD` daily close from CoinGecko free API (`/coins/usd-coin/history`);
  `USD/<baseCurrency>` daily from frankfurter.app (ECB-backed, keyless).
- Cached permanently in `rates` table with provenance; a report re-run NEVER
  re-fetches a cached day (determinism). Missing rate for a needed day after fetch
  attempt → structured error, report marked incomplete.
- `--stale-rates-ok` flag allows previous-known-day fallback, noted in the footer.

## Reports

All reports: `x402-books report --period 2026-07 [--out DIR]` → writes
`<out>/<period>/` containing every applicable report as `.md` (human) + `.csv`
(machine). Period = calendar month in the configured timezone (v1: month only).

1. **revenue** — gross USDC, net (minus known facilitator fees), settlement count;
   grouped by product, endpoint, chain; unattributed on-chain revenue shown as its
   own "(unattributed)" line so totals always reconcile to the wallet.
2. **valuation** — per-settlement fiat value (amount × USDC/USD × USD/base, that
   day's rates); CSV line items + md summary by day.
3. **journal** — Xero/QuickBooks-importable CSV: one journal line per
   (day × product) rollup, debit/credit columns, mapped account names configurable
   via `books.json` `accounts` block with sane defaults ("x402 Revenue",
   "USDC Clearing", "Facilitator Fees").
4. **pack_za** (when jurisdiction=ZA) — provisional-tax-oriented income summary:
   period gross revenue income in ZAR (income recognized at receipt, SARS revenue
   treatment per owner's documented position), monthly totals, YTD line.
5. **pack_us** (when jurisdiction=US) — Schedule-C-oriented ordinary-income summary
   in USD at receipt FMV, monthly totals, YTD line.
6. **costbasis** — CSV of receipt lots (date, asset, quantity, unit FMV in USD,
   basis) formatted for import into Koinly-class tools. Both packs state in their
   footer: disposal/CGT is out of scope; use this export.

**Report integrity (hard rules):**
- Any ingest or rate failure ⇒ every affected report renders with a prominent
  `⚠ INCOMPLETE — <source>: <reason>` banner at the top; process exit code 1.
  Silence is never an acceptable failure mode in accounting output.
- Every report footer: sources used, per-source watermark/row-count, rate
  provenance per pair, timezone, generation timestamp, tool version.

## CLI

```
x402-books init                  # write books.json.example → books.json (no clobber)
x402-books sync [--from-block N] # run all ingesters + fetch missing rates
x402-books report --period YYYY-MM [--out DIR] [--stale-rates-ok]
x402-books status                # wallets, watermarks, row counts, cached rate days
```

`report` runs an implicit `sync` first unless `--no-sync`. Exit codes: 0 clean,
1 completed-with-incomplete-data, 2 config/usage error.

## Monetization path (recorded, NOT built in v1)

v1.5+: x402-payable hosted report endpoint served through the owner's x402-sandbox
(`proxyUrl` product type), CDP facilitator + Stripe CSV importers (hybrid-rail
reconciliation), Solana ingester. None of this appears in v1 code.

## Success criteria (v1 exit)

1. Against the owner's real wallet + live x402-sandbox DB: `sync` then
   `report --period 2026-07` produces all six outputs; revenue statement reconciles
   to the wallet's on-chain USDC receipts for the period, and the store's $1.00
   mainnet sale appears attributed to its product.
2. Golden-fixture test suite green with ≥80% coverage on `src/`.
3. Fresh-machine dry run: `git clone && node bin/x402-books.js init && … report`
   works with zero `npm install` (no runtime deps).
