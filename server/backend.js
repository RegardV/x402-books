#!/usr/bin/env node
// Unpaid compute backend for x402-books, meant to sit behind the x402-sandbox proxy
// on localhost. The SANDBOX handles all payment (402/verify/settle) and its own env
// (PAY_TO, NETWORK, FACILITATOR_URL, CDP keys); this process just computes the report
// for the wallet in the forwarded request body. Bind to localhost only — it is not
// meant to be publicly reachable; the sandbox is the paid front door.
//
// Env:
//   PORT                  default 8404 (set the sandbox product's proxyUrl to match)
//   X402_BOOKS_BASESCAN_KEY  optional Basescan key for the on-chain scan
import http from 'node:http';
import { setDefaultResultOrder } from 'node:dns';
// This host's IPv6 egress is unreliable (undici tries AAAA first and hangs); the
// on-chain scan calls out over HTTP, so prefer IPv4 for deterministic behavior.
setDefaultResultOrder('ipv4first');
import { runReport } from '../src/report-service.js';
import { validateReportRequest } from '../src/x402.js';

const PORT = parseInt(process.env.PORT ?? '8404', 10);
const BASESCAN_KEY = process.env.X402_BOOKS_BASESCAN_KEY ?? '';
const MAX_BODY = 4096;

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
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

async function respondReport(res, input) {
  const reqData = validateReportRequest(input); // throws RequestError (status 400)
  const result = await runReport(reqData, { basescanKey: BASESCAN_KEY });
  send(res, 200, {
    wallet: reqData.wallet, period: reqData.period,
    ...(reqData.to ? { to: reqData.to } : {}),
    jurisdiction: reqData.jurisdiction, baseCurrency: reqData.baseCurrency,
    reports: result.reports, incomplete: result.incomplete,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      return send(res, 200, { service: 'x402-books-backend', status: 'ok', endpoint: 'POST /report {wallet, period, jurisdiction} — or GET /report?wallet=&period=&jurisdiction=' });
    }
    // POST /report — JSON body (agent path). GET /report — query params (human form
    // path: the sandbox paywall retries the parameterized GET after payment).
    if (path === '/report' && (req.method === 'POST' || req.method === 'GET')) {
      if (req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'body must be valid JSON' }); }
        return await respondReport(res, body);
      }
      const q = new URL(req.url, 'http://localhost').searchParams;
      return await respondReport(res, {
        wallet: q.get('wallet') ?? undefined,
        period: q.get('period') ?? undefined,
        ...(q.get('to') ? { to: q.get('to') } : {}),
        ...(q.get('jurisdiction') !== null ? { jurisdiction: q.get('jurisdiction') } : {}),
        ...(q.get('baseCurrency') !== null ? { baseCurrency: q.get('baseCurrency') } : {}),
      });
    }
    send(res, 404, { error: 'not found — use POST or GET /report' });
  } catch (e) {
    if (e.status === 400 || e.status === 413) return send(res, e.status, { error: e.message });
    console.error('[x402-books-backend] error:', e); // detail server-side only
    send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`x402-books backend on 127.0.0.1:${PORT} — POST /report (unpaid; front it with the x402-sandbox proxy)`);
});
