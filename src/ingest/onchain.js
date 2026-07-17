import { upsertSettlement, getWatermark, setWatermark } from '../ledger.js';

export class IngestError extends Error {
  constructor(source, msg) { super(msg); this.source = source; }
}

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_FROM_BLOCK = 2797222;
const RPC_URL = 'https://mainnet.base.org';
const RPC_WINDOW = 10_000;

const pad32 = (addr) => '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function explorerBase(cfg) {
  return cfg.basescanApiKey
    ? { url: 'https://api.basescan.org/api', key: `&apikey=${cfg.basescanApiKey}` }
    : { url: 'https://base.blockscout.com/api', key: '' };
}

async function getJson(fetchFn, url, init) {
  const res = await fetchFn(url, init);
  if (!res.ok) throw new IngestError('onchain', `HTTP ${res.status} from ${typeof url === 'string' ? url.split('?')[0] : url}`);
  return res.json();
}

async function rpc(fetchFn, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const data = await getJson(fetchFn, RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (data.error) throw new IngestError('onchain', `rpc ${method}: ${data.error.message}`);
  return data.result;
}

async function headBlock(fetchFn, cfg) {
  const { url, key } = explorerBase(cfg);
  try {
    const d = await getJson(fetchFn, `${url}?module=proxy&action=eth_blockNumber${key}`);
    if (d.result) return parseInt(d.result, 16);
  } catch { /* fall through to rpc */ }
  return parseInt(await rpc(fetchFn, 'eth_blockNumber', []), 16);
}

function parseLog(entry, tsOverride = null) {
  return {
    tx_hash: entry.transactionHash,
    log_index: parseInt(entry.logIndex ?? '0x0', 16) || 0,
    block_number: parseInt(entry.blockNumber, 16),
    ts: tsOverride ?? parseInt(entry.timeStamp, 16),
    payer: '0x' + entry.topics[1].slice(26),
    amount_atomic: BigInt(entry.data).toString(),
  };
}

async function explorerLogs(fetchFn, cfg, wallet, fromBlock, toBlock, sleepMs) {
  const { url, key } = explorerBase(cfg);
  const out = [];
  let from = fromBlock;
  for (;;) {
    const q = `${url}?module=logs&action=getLogs&fromBlock=${from}&toBlock=${toBlock}` +
      `&address=${cfg.chains.base.usdc}&topic0=${TRANSFER_TOPIC}&topic2=${pad32(wallet)}&topic0_2_opr=and${key}`;
    const d = await getJson(fetchFn, q);
    if (d.status === '0' && !/no records/i.test(d.message ?? '')) throw new IngestError('onchain', `explorer: ${d.message}`);
    const batch = Array.isArray(d.result) ? d.result : [];
    out.push(...batch.map((e) => parseLog(e)));
    if (batch.length < 1000) return out;
    from = parseInt(batch.at(-1).blockNumber, 16) + 1;
    await sleep(sleepMs);
  }
}

async function rpcLogs(fetchFn, cfg, wallet, fromBlock, toBlock, sleepMs) {
  const out = [];
  const blockTs = new Map();
  for (let from = fromBlock; from <= toBlock; from += RPC_WINDOW) {
    const to = Math.min(from + RPC_WINDOW - 1, toBlock);
    const logs = await rpc(fetchFn, 'eth_getLogs', [{
      address: cfg.chains.base.usdc,
      topics: [TRANSFER_TOPIC, null, pad32(wallet)],
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
    }]);
    for (const entry of logs) {
      const bn = parseInt(entry.blockNumber, 16);
      if (!blockTs.has(bn)) {
        const blk = await rpc(fetchFn, 'eth_getBlockByNumber', ['0x' + bn.toString(16), false]);
        blockTs.set(bn, parseInt(blk.timestamp, 16));
      }
      out.push(parseLog(entry, blockTs.get(bn)));
    }
    await sleep(sleepMs);
  }
  return out;
}

export async function ingestOnchain(db, cfg, { fetchFn = globalThis.fetch, fromBlock = null, sleepMs = 250 } = {}) {
  let inserted = 0, updated = 0;
  const warnings = [];
  const head = await headBlock(fetchFn, cfg);

  for (const wallet of cfg.wallets) {
    const wmKey = `onchain:base:${wallet.toLowerCase()}`;
    const wm = getWatermark(db, wmKey);
    const start = fromBlock ?? (wm ? parseInt(wm, 10) + 1 : DEFAULT_FROM_BLOCK);
    if (start > head) continue;

    let logs;
    try {
      logs = await explorerLogs(fetchFn, cfg, wallet, start, head, sleepMs);
    } catch {
      logs = await rpcLogs(fetchFn, cfg, wallet, start, head, sleepMs);
    }

    for (const l of logs) {
      const prior = db.prepare('SELECT log_index, source FROM settlements WHERE tx_hash = ? AND chain = ?').get(l.tx_hash, 'base');
      if (prior && prior.source === 'onchain' && prior.log_index !== l.log_index) {
        warnings.push(`tx ${l.tx_hash}: multiple USDC transfers in one tx — only one recorded (known v1 ceiling)`);
      }
      const action = upsertSettlement(db, {
        ...l, chain: 'base', payee: wallet.toLowerCase(), token: 'USDC', source: 'onchain',
      });
      if (action === 'inserted') inserted++; else updated++;
    }
    setWatermark(db, wmKey, String(head));
    if (wallet !== cfg.wallets.at(-1)) await sleep(sleepMs); // throttle only between wallets
  }
  return { inserted, updated, warnings, toBlock: head };
}
