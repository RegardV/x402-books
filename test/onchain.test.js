import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, settlementsAll, getWatermark } from '../src/ledger.js';
import { ingestOnchain } from '../src/ingest/onchain.js';

const WALLET = '0x' + 'ab'.repeat(20);
const CFG = { wallets: [WALLET], chains: { base: { usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } }, basescanApiKey: '' };
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function logEntry(tx, block, tsSec, amountAtomic, payer, logIndex = 0) {
  return {
    transactionHash: tx,
    blockNumber: '0x' + block.toString(16),
    timeStamp: '0x' + tsSec.toString(16),
    logIndex: '0x' + logIndex.toString(16),
    data: '0x' + BigInt(amountAtomic).toString(16).padStart(64, '0'),
    topics: [T0, pad(payer), pad(WALLET)],
  };
}

function fakeFetch(script) {
  // script: array of (url) => response-object or null (pass to next)
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    for (const h of script) {
      const r = h(String(url));
      if (r) return { ok: true, status: 200, json: async () => r };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}
const headHandler = (u) => (u.includes('eth_blockNumber') ? { result: '0x' + (5000000).toString(16) } : null);

test('happy path: two transfers land, watermark set, rerun idempotent', async () => {
  const db = openLedger(':memory:');
  const logs = [logEntry('0xt1', 4000001, 1752700000, '1000000', '0x' + '11'.repeat(20)),
                logEntry('0xt2', 4000002, 1752700100, '20000',   '0x' + '22'.repeat(20), 3)];
  const f = fakeFetch([headHandler, (u) => (u.includes('action=getLogs') ? { status: '1', result: logs } : null)]);
  const r1 = await ingestOnchain(db, CFG, { fetchFn: f });
  assert.equal(r1.inserted, 2);
  const rows = settlementsAll(db);
  assert.equal(rows[0].amount_atomic, '1000000');
  assert.equal(rows[0].payer, '0x' + '11'.repeat(20));
  assert.equal(rows[0].source, 'onchain');
  assert.equal(getWatermark(db, `onchain:base:${WALLET.toLowerCase()}`), '5000000');
  const r2 = await ingestOnchain(db, CFG, { fetchFn: f });
  assert.equal(r2.inserted, 0);
});
test('no records found is clean empty', async () => {
  const db = openLedger(':memory:');
  const f = fakeFetch([headHandler, (u) => (u.includes('action=getLogs') ? { status: '0', message: 'No records found', result: [] } : null)]);
  const r = await ingestOnchain(db, CFG, { fetchFn: f });
  assert.equal(r.inserted, 0);
});
test('explorer down falls back to rpc getLogs windows', async () => {
  const db = openLedger(':memory:');
  const rpcLog = { transactionHash: '0xt9', blockNumber: '0x3d0901', logIndex: '0x0',
    data: '0x' + BigInt(500000).toString(16).padStart(64, '0'),
    topics: [T0, pad('0x' + '33'.repeat(20)), pad(WALLET)] };
  // RPC fake needs POST body inspection — use a custom fn instead:
  const calls = [];
  const rpc = async (url, init) => {
    calls.push(String(url));
    if (!String(url).includes('mainnet.base.org')) return { ok: false, status: 500, json: async () => ({}) };
    const body = JSON.parse(init.body);
    if (body.method === 'eth_blockNumber') return { ok: true, status: 200, json: async () => ({ result: '0x3d0a00' }) };
    if (body.method === 'eth_getLogs') {
      const from = parseInt(body.params[0].fromBlock, 16);
      return { ok: true, status: 200, json: async () => ({ result: from <= 0x3d0901 && 0x3d0901 <= parseInt(body.params[0].toBlock, 16) ? [rpcLog] : [] }) };
    }
    if (body.method === 'eth_getBlockByNumber') return { ok: true, status: 200, json: async () => ({ result: { timestamp: '0x' + (1752701000).toString(16) } }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const r = await ingestOnchain(db, CFG, { fetchFn: rpc, fromBlock: 0x3d0900, sleepMs: 0 });
  assert.equal(r.inserted, 1);
  assert.equal(settlementsAll(db)[0].ts, 1752701000);
});
test('multi-transfer same tx warns', async () => {
  const db = openLedger(':memory:');
  const logs = [logEntry('0xtX', 4000001, 1752700000, '1000000', '0x' + '11'.repeat(20), 1),
                logEntry('0xtX', 4000001, 1752700000, '2000000', '0x' + '11'.repeat(20), 2)];
  const f = fakeFetch([headHandler, (u) => (u.includes('action=getLogs') ? { status: '1', result: logs } : null)]);
  const r = await ingestOnchain(db, CFG, { fetchFn: f });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /0xtX/);
});
