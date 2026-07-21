import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChallenge, challengeHeader, decodePayment, receiptHeader, validateReportRequest, Facilitator } from '../src/x402.js';

const product = {
  url: 'https://svc.example/report', description: 'x402 books', mimeType: 'application/json',
  amountMicro: '20000', network: 'eip155:84532', payTo: '0x26EED96B8e61a9123Ff29C54D00fEb452539E33E',
};

test('buildChallenge produces spec-shaped v2 402 with testnet USDC', () => {
  const c = buildChallenge(product);
  assert.equal(c.x402Version, 2);
  const a = c.accepts[0];
  assert.equal(a.scheme, 'exact');
  assert.equal(a.network, 'eip155:84532');
  assert.equal(a.amount, '20000'); // stringified
  assert.equal(a.asset, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  assert.equal(a.payTo, product.payTo);
  assert.equal(a.maxTimeoutSeconds, 300);
  assert.deepEqual(a.extra, { name: 'USDC', version: '2' });
});

test('buildChallenge caps long descriptions and rejects unknown networks', () => {
  const long = buildChallenge({ ...product, description: 'x'.repeat(400) });
  assert.ok(long.resource.description.length <= 250);
  assert.throws(() => buildChallenge({ ...product, network: 'eip155:1' }), /unsupported network/);
});

test('challengeHeader base64-encodes the challenge for the payment-required header (v2 SDK reads this, not the body)', () => {
  const decoded = JSON.parse(Buffer.from(challengeHeader(product), 'base64').toString('utf8'));
  assert.deepEqual(decoded, buildChallenge(product));
  assert.equal(decoded.x402Version, 2);
});

test('decodePayment round-trips a valid header and rejects junk', () => {
  const payload = { x402Version: 2, scheme: 'exact', payload: { sig: '0xabc' } };
  const header = Buffer.from(JSON.stringify(payload)).toString('base64');
  assert.deepEqual(decodePayment(header), payload);
  assert.equal(decodePayment(''), null);
  assert.equal(decodePayment(null), null);
  assert.equal(decodePayment(Buffer.from('{"no":"version"}').toString('base64')), null);
  assert.equal(decodePayment('!!!not base64 json!!!'), null);
});

test('receiptHeader encodes the settle result', () => {
  const h = receiptHeader({ ok: true, payer: '0xpayer', tx: '0xhash', network: 'eip155:84532' });
  const decoded = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
  assert.deepEqual(decoded, { success: true, payer: '0xpayer', transaction: '0xhash', network: 'eip155:84532' });
});

test('validateReportRequest accepts good input and derives baseCurrency', () => {
  assert.deepEqual(
    validateReportRequest({ wallet: product.payTo, period: '2026-07', jurisdiction: 'ZA' }),
    { wallet: product.payTo, period: '2026-07', jurisdiction: 'ZA', baseCurrency: 'ZAR' },
  );
  assert.equal(validateReportRequest({ wallet: product.payTo, period: '2026-07' }).baseCurrency, 'USD'); // default NONE→USD
  assert.equal(validateReportRequest({ wallet: product.payTo, period: '2026-07' }).jurisdiction, 'NONE');
});

test('validateReportRequest accepts an optional to (range) and normalizes empty', () => {
  const base = { wallet: product.payTo, period: '2026-01' };
  assert.equal(validateReportRequest({ ...base, to: '2026-06' }).to, '2026-06');
  assert.equal(validateReportRequest({ ...base, to: '2026-01' }).to, '2026-01'); // equal is allowed
  assert.equal('to' in validateReportRequest(base), false);            // absent → no to
  assert.equal('to' in validateReportRequest({ ...base, to: '' }), false); // empty → no to (single month)
});

test('validateReportRequest rejects a bad or backwards range', () => {
  const base = { wallet: product.payTo, period: '2026-06' };
  assert.throws(() => validateReportRequest({ ...base, to: '2026-1' }), (e) => e.status === 400);   // malformed
  assert.throws(() => validateReportRequest({ ...base, to: '2026-05' }), (e) => e.status === 400);  // to < period
});

test('validateReportRequest rejects bad input at the trust boundary', () => {
  const bad = [
    {},
    { wallet: '0x123', period: '2026-07' },                        // short address
    { wallet: product.payTo, period: '2026-7' },                   // malformed period
    { wallet: product.payTo, period: '2026-13' },                  // month out of range
    { wallet: product.payTo, period: '2026-07', jurisdiction: 'UK' }, // unknown jurisdiction
    { wallet: product.payTo, period: '2026-07', baseCurrency: 'zar' }, // lowercase
  ];
  for (const b of bad) assert.throws(() => validateReportRequest(b), (e) => e.status === 400, JSON.stringify(b));
});

test('Facilitator.verify/settle map facilitator responses (injected fetch)', async () => {
  const okFetch = (body) => async () => ({ status: 200, json: async () => body });
  const vOk = await new Facilitator(okFetch({ isValid: true }), 'https://f').verify({ x402Version: 2 }, {});
  assert.equal(vOk.ok, true);
  const vBad = await new Facilitator(okFetch({ isValid: false, invalidReason: 'nope' }), 'https://f').verify({ x402Version: 2 }, {});
  assert.deepEqual(vBad, { ok: false, error: 'nope' });
  const sOk = await new Facilitator(okFetch({ success: true, transaction: '0xtx', payer: '0xp', network: 'n' }), 'https://f').settle({ x402Version: 2 }, {});
  assert.deepEqual(sOk, { ok: true, tx: '0xtx', payer: '0xp', network: 'n' });
  // transport failure never throws
  const throwFetch = async () => { throw new Error('econnrefused'); };
  const sErr = await new Facilitator(throwFetch, 'https://f').settle({ x402Version: 2 }, {});
  assert.equal(sErr.ok, false);
  assert.match(sErr.error, /econnrefused/);
});
