#!/usr/bin/env node
// Paid x402 service wrapping x402-books: POST { wallet, period, jurisdiction } →
// pay USDC over x402 → accountant-ready reports for that public wallet, as JSON.
// Stateless: each request runs in a throwaway in-memory ledger and stores nothing.
//
// Env:
//   X402_PAY_TO           (required) operator receive wallet for the service fee
//   X402_PUBLIC_URL       public URL of this endpoint (default http://localhost:PORT/report)
//   X402_FACILITATOR_URL  default https://x402.org/facilitator (Base Sepolia testnet)
//   X402_NETWORK          default eip155:84532 (testnet). Mainnet: eip155:8453 (needs CDP auth — not wired yet)
//   X402_PRICE_MICRO      service fee in USDC atomic units, default 20000 ($0.02)
//   X402_DESCRIPTION      402 challenge description
//   X402_BASESCAN_KEY     optional Basescan key for the report's on-chain scan
//   PORT                  default 8402
import http from 'node:http';
import { setDefaultResultOrder } from 'node:dns';
// This host's IPv6 egress is unreliable (undici tries AAAA first and hangs →
// "fetch failed"). Prefer IPv4 so facilitator verify/settle calls are deterministic.
setDefaultResultOrder('ipv4first');
import { runReport } from '../src/report-service.js';
import { buildChallenge, challengeHeader, decodePayment, receiptHeader, validateReportRequest, Facilitator } from '../src/x402.js';

const env = process.env;
const PORT = parseInt(env.PORT ?? '8402', 10);
const PAY_TO = env.X402_PAY_TO ?? '';
const FACILITATOR_URL = env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator';
const NETWORK = env.X402_NETWORK ?? 'eip155:84532';
const PRICE_MICRO = env.X402_PRICE_MICRO ?? '20000';
const PUBLIC_URL = env.X402_PUBLIC_URL ?? `http://localhost:${PORT}/report`;
const DESCRIPTION = env.X402_DESCRIPTION
  ?? 'Accountant-ready x402 books for a wallet. POST {wallet, period, jurisdiction} and get revenue/valuation/journal/costbasis reports.';
const BASESCAN_KEY = env.X402_BASESCAN_KEY ?? '';
const MAX_BODY = 4096;

function product() {
  return { url: PUBLIC_URL, description: DESCRIPTION, mimeType: 'application/json', amountMicro: PRICE_MICRO, network: NETWORK, payTo: PAY_TO };
}

function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// 402 with the challenge in BOTH the body and the `payment-required` header —
// the v2 SDK reads the header, the body is human/legacy-readable.
function send402(res) {
  const p = product();
  send(res, 402, buildChallenge(p), { 'payment-required': challengeHeader(p) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) { reject(Object.assign(new Error('request body too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const facilitator = new Facilitator(fetch, FACILITATOR_URL);

async function handleReport(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return send(res, 400, { error: 'body must be valid JSON' });
  }
  const reqData = validateReportRequest(body); // throws RequestError (status 400)

  const header = req.headers['payment-signature'] ?? req.headers['x-payment'];
  const payment = decodePayment(Array.isArray(header) ? header[0] : header);
  if (!payment) return send402(res);

  const requirements = buildChallenge(product()).accepts[0];
  const verified = await facilitator.verify(payment, requirements);
  if (!verified.ok) {
    console.error(`[x402] verify failed: ${verified.error}`);
    return send402(res);
  }

  // Deliver, THEN settle — matches the plugin's order so a settle failure doesn't
  // charge for nothing. Report is computed before money moves.
  const result = await runReport(reqData, { basescanKey: BASESCAN_KEY });

  const settled = await facilitator.settle(payment, requirements);
  if (!settled.ok) {
    console.error(`[x402] settle failed: ${settled.error}`);
    return send402(res);
  }

  send(res, 200, {
    wallet: reqData.wallet,
    period: reqData.period,
    jurisdiction: reqData.jurisdiction,
    baseCurrency: reqData.baseCurrency,
    reports: result.reports,
    incomplete: result.incomplete,
    receipt: { transaction: settled.tx, payer: settled.payer, network: settled.network },
  }, { 'payment-response': receiptHeader(settled) });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      return send(res, 200, { service: 'x402-books', status: 'ok', network: NETWORK, price_micro: PRICE_MICRO, endpoint: 'POST /report {wallet, period, jurisdiction}' });
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/report') {
      return await handleReport(req, res);
    }
    send(res, 404, { error: 'not found — use POST /report' });
  } catch (e) {
    if (e.status === 400 || e.status === 413) return send(res, e.status, { error: e.message });
    console.error('[x402-books] server error:', e); // full detail server-side only
    send(res, 500, { error: 'internal error' }); // never leak stack to client
  }
});

if (!PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) {
  console.error('FATAL: set X402_PAY_TO to your 0x receive wallet before starting.');
  process.exit(2);
}

server.listen(PORT, () => {
  console.log(`x402-books service on :${PORT} — network ${NETWORK}, fee ${PRICE_MICRO} atomic USDC, facilitator ${FACILITATOR_URL}`);
  console.log(`  POST /report  { "wallet": "0x…", "period": "YYYY-MM", "jurisdiction": "ZA|US|NONE" }`);
});
