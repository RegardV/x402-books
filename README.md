# x402-books

Accountant-ready reports for x402 sellers — local-first, zero dependencies.
By [realandworks.com](https://realandworks.com).

## The problem

x402 sellers earn micro-revenue — thousands of $0.01–$1.00 USDC settlements — across
chains and rails, with zero accounting tooling: facilitators settle payments but don't
report on them. Generic crypto-accounting tools (Koinly, Cryptio, …) price per
transaction, which breaks down at micropayment volume, and see only raw transfers with
no x402 semantics (which product, which endpoint, gross vs fee) — and QuickBooks itself
only handles two decimal places, not USDC's six. Even the protocol's own ecosystem
notices the hole: WorkOS's x402-vs-MPP comparison names "no accounting reconciliation
out of the box" as x402's gap.

## What you get

Run `x402-books report --period YYYY-MM` and get six accountant-ready outputs, each as
`.md` (human) + `.csv` (machine):

- **revenue** — gross/net USDC and settlement counts, grouped by product, endpoint, and
  chain, with unattributed on-chain revenue broken out so totals always reconcile.
- **valuation** — per-settlement fiat value at that day's rates, line items + daily summary.
- **journal** — Xero/QuickBooks-importable CSV, one line per (day × product) rollup,
  with configurable account names.
- **pack_za** *(jurisdiction=ZA)* — provisional-tax-oriented income summary in ZAR,
  monthly totals + YTD.
- **pack_us** *(jurisdiction=US)* — Schedule-C-oriented ordinary-income summary in USD
  at receipt FMV, monthly totals + YTD.
- **costbasis** — CSV of receipt lots (date, asset, quantity, unit FMV, basis) formatted
  for import into Koinly-class tools, for the disposal/CGT side this tool doesn't cover.

## Install

```sh
git clone https://github.com/RegardV/x402-books.git
cd x402-books
node bin/x402-books.js init
```

Zero runtime npm dependencies — no `npm install` needed. Requires Node >= 22.5 (uses
`node:sqlite` and `node:test`).

## Configure

`init` copies `books.json.example` to `./books.json` (it never overwrites an existing
one). Edit it:

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

- `wallets` — required, at least one, each `0x` + 40 hex chars: the payTo addresses to
  watch for on-chain USDC settlements.
- `sandboxDbs` — optional paths to x402-sandbox SQLite files, for product/endpoint
  attribution beyond what's visible on-chain.
- `baseCurrency` — ISO-4217 code fiat values are rendered in.
- `jurisdiction` — one of `ZA`, `US`, `NONE`; controls which tax pack gets generated.
- `timezone` — IANA timezone string (default `UTC`); every report date is the
  settlement timestamp converted to this zone, and every footer states it.
- `dataDir` — where the ledger (`books.db`) and rate cache live (`~` is expanded).
- `chains` — optional override of the USDC contract address per chain (the Base
  default shown is correct for everyone; touch only if the contract migrates).
- `basescanApiKey` — optional; when set, on-chain scanning uses Basescan instead of
  the keyless Blockscout API (higher rate limits).
- `accounts` — optional; the defaults above are used when omitted.

Config validation fails fast, naming the bad field — no partial runs on bad config.

## Use

```sh
x402-books sync                          # run ingesters + fetch missing rates
x402-books report --period 2026-07       # sync (implicit) + write all reports
x402-books status                        # wallets, watermarks, row counts, cached rates
```

`report` runs an implicit `sync` first unless `--no-sync` is passed. Reports land in
`<out>/<period>/<name>.{md,csv}` (default `--out ./reports`).

| Flag | Applies to | Meaning |
|---|---|---|
| `--config F` | all | path to `books.json` (default `./books.json`) |
| `--out DIR` | `report` | output directory (default `./reports`) |
| `--from-block N` | `sync`, `report` | first block to scan on a fresh on-chain sync |
| `--skip-onchain` | `sync`, `report` | skip on-chain ingestion — offline/testing mode |
| `--stale-rates-ok` | `sync`, `report` | fall back to the last known rate when today's is missing, noted in the footer |
| `--no-sync` | `report` | skip the implicit sync, report from the ledger as-is |

Exit codes: `0` clean, `1` completed with incomplete data (see below), `2` config or
usage error.

## How it values things

- **Atomic-unit math.** USDC amounts are stored and summed as integer atomic-unit
  strings (6dp) end to end — never floats. Floats appear only when applying fiat rates
  at render time, each line rounded half-up to 2dp; rendered totals are the sum of the
  rounded lines, so tables always reconcile visually.
- **Daily rates with provenance.** `USDC/USD` and `USD/<baseCurrency>` rates are fetched
  once per day and cached permanently — a re-run never re-fetches a cached day. Every
  report footer states the provenance (source) per pair.
- **Timezone attribution.** Every settlement is dated by converting its on-chain
  timestamp into the configured `timezone` — never `toISOString().slice(0,10)` — and
  every footer states which timezone was used.
- **Integrity banner + exit codes.** Any ingest or rate failure makes every affected
  report render a `⚠ INCOMPLETE — <source>: <reason>` banner at the top and the process
  exit `1`. Silence is never an acceptable failure mode in accounting output.

## Scope boundary

x402-books covers the income side only: what came in, when, in what fiat terms, and to
which product. It does not track disposal or capital gains on held crypto — the
**costbasis** report exists specifically to hand that off, in Koinly-compatible form, to
a tool built for it.

## Roadmap

Not built in v1, recorded for later: CDP facilitator + Stripe CSV importers (hybrid-rail
reconciliation), a Solana ingester, and an x402-payable hosted report endpoint served
through the owner's x402-sandbox.

## License

MIT. Credits: the [x402 protocol](https://x402.org) (Coinbase / x402 Foundation).
