// x402 server-side protocol, ported from the tested x402-wordpress PHP plugin
// (includes/class-challenge.php, class-facilitator.php). Zero dependencies:
// the seller never signs, so no SDK/viem — just the 402 challenge + facilitator
// verify/settle HTTP round-trips. Buyers sign; the facilitator broadcasts.

// USDC per network: contract + EIP-712 domain (production-verified in the WP plugin).
const USDC = {
  'eip155:8453': { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2' },
  'eip155:84532': { asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2' },
};

// CDP facilitator rejects payloads whose embedded description exceeds ~256 chars.
const DESCRIPTION_MAX = 250;

function capDescription(d) {
  return d.length <= DESCRIPTION_MAX ? d : d.slice(0, DESCRIPTION_MAX - 1) + '…';
}

// product: { url, description, mimeType, amountMicro, network, payTo }
export function buildChallenge(product) {
  const usdc = USDC[product.network];
  if (!usdc) throw new Error(`unsupported network: ${product.network}`);
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: {
      url: product.url,
      description: capDescription(product.description),
      mimeType: product.mimeType,
    },
    accepts: [{
      scheme: 'exact',
      network: product.network,
      amount: String(product.amountMicro),
      asset: usdc.asset,
      payTo: product.payTo,
      maxTimeoutSeconds: 300,
      extra: { name: usdc.name, version: usdc.version },
    }],
  };
}

// Base64 of the challenge JSON, for the `payment-required` response header.
// The v2 SDK reads requirements from THIS header (the body is only honored for v1).
export function challengeHeader(product) {
  return Buffer.from(JSON.stringify(buildChallenge(product))).toString('base64');
}

// Decode a payment header (base64 JSON with x402Version), verbatim. Null if malformed.
export function decodePayment(header) {
  if (!header) return null;
  let json;
  try {
    json = Buffer.from(header, 'base64').toString('utf8');
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || payload.x402Version === undefined) return null;
  return payload;
}

// PAYMENT-RESPONSE receipt header for the buyer.
export function receiptHeader(settle) {
  return Buffer.from(JSON.stringify({
    success: settle.ok,
    payer: settle.payer,
    transaction: settle.tx,
    network: settle.network,
  })).toString('base64');
}

// Facilitator HTTP client. Never throws on payment/transport failure — every path
// returns { ok, ... }. `fetchFn` is injectable for tests; `auth(endpoint)` returns
// per-endpoint headers (CDP mainnet) or nothing (x402.org testnet).
export class Facilitator {
  constructor(fetchFn, url, auth = null) {
    this.fetch = fetchFn;
    this.url = url.replace(/\/+$/, '');
    this.auth = auth;
  }

  async #post(endpoint, paymentPayload, requirements) {
    const headers = { 'Content-Type': 'application/json', ...(this.auth ? this.auth(endpoint) : {}) };
    const body = JSON.stringify({
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements: requirements,
    });
    // One retry on transport failure — a transient network blip must not drop a
    // verify/settle on the money path. HTTP-level errors (4xx/5xx) are not retried.
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetch(`${this.url}/${endpoint}`, { method: 'POST', headers, body });
        let json = {};
        try { json = await res.json(); } catch { /* leave {} */ }
        return { code: res.status, body: json };
      } catch (e) {
        last = { code: 0, body: {}, error: e.message };
      }
    }
    return last;
  }

  async verify(paymentPayload, requirements) {
    const r = await this.#post('verify', paymentPayload, requirements);
    if (r.code !== 200 || r.body.isValid !== true) {
      return { ok: false, error: r.body.invalidReason ?? r.error ?? r.body.error ?? `facilitator verify failed (${r.code})` };
    }
    return { ok: true };
  }

  async settle(paymentPayload, requirements) {
    const r = await this.#post('settle', paymentPayload, requirements);
    if (r.code !== 200 || r.body.success !== true) {
      return { ok: false, error: r.body.errorReason ?? r.error ?? `facilitator settle failed (${r.code})` };
    }
    return { ok: true, tx: r.body.transaction ?? '', payer: r.body.payer ?? '', network: r.body.network ?? '' };
  }
}

class RequestError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// Validate the untrusted buyer request body → normalized { wallet, period, jurisdiction, baseCurrency }.
export function validateReportRequest(body) {
  if (typeof body !== 'object' || body === null) throw new RequestError('body must be a JSON object');
  const wallet = body.wallet;
  if (typeof wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw new RequestError('wallet must be a 0x-prefixed 40-hex-char address');
  }
  const period = body.period;
  if (typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new RequestError('period must be YYYY-MM');
  }
  let to = body.to;
  if (to === undefined || to === null || to === '') {
    to = undefined;
  } else if (typeof to !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(to)) {
    throw new RequestError('to must be YYYY-MM');
  } else if (to < period) {
    throw new RequestError('to must be >= period (range is period..to)');
  }
  const jurisdiction = body.jurisdiction ?? 'NONE';
  if (!['ZA', 'US', 'NONE'].includes(jurisdiction)) {
    throw new RequestError('jurisdiction must be ZA, US, or NONE');
  }
  let baseCurrency = body.baseCurrency;
  if (baseCurrency === undefined) {
    baseCurrency = jurisdiction === 'ZA' ? 'ZAR' : 'USD';
  } else if (typeof baseCurrency !== 'string' || !/^[A-Z]{3}$/.test(baseCurrency)) {
    throw new RequestError('baseCurrency must be a 3-letter uppercase ISO code');
  }
  return { wallet, period, jurisdiction, baseCurrency, ...(to !== undefined ? { to } : {}) };
}
