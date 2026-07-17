import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export class ConfigError extends Error {}

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEFAULTS = {
  sandboxDbs: [],
  chains: { base: { usdc: USDC_BASE } },
  timezone: 'UTC',
  basescanApiKey: '',
  dataDir: '~/.x402-books',
  accounts: { revenue: 'x402 Revenue', clearing: 'USDC Clearing', fees: 'Facilitator Fees' },
};

export function expandHome(p) {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p;
}

function bad(field, why) {
  throw new ConfigError(`books.json: ${field} ${why}`);
}

export function loadConfig(file = 'books.json') {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`config file not found: ${file} (run: x402-books init)`);
  }
  let user;
  try {
    user = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`config file ${file} is not valid JSON: ${e.message}`);
  }
  const cfg = { ...DEFAULTS, ...user };
  cfg.accounts = { ...DEFAULTS.accounts, ...(user.accounts || {}) };
  cfg.chains = { base: { ...DEFAULTS.chains.base, ...(user.chains?.base || {}) } };

  if (!Array.isArray(cfg.wallets) || cfg.wallets.length === 0) bad('wallets', 'must be a non-empty array');
  for (const w of cfg.wallets) {
    if (typeof w !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(w)) bad('wallets', `contains invalid address: ${w}`);
  }
  if (typeof cfg.baseCurrency !== 'string' || !/^[A-Z]{3}$/.test(cfg.baseCurrency)) bad('baseCurrency', 'must be a 3-letter uppercase ISO code');
  if (!['ZA', 'US', 'NONE'].includes(cfg.jurisdiction)) bad('jurisdiction', 'must be ZA, US, or NONE');
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone });
  } catch {
    bad('timezone', `is not a valid IANA timezone: ${cfg.timezone}`);
  }
  if (!Array.isArray(cfg.sandboxDbs)) bad('sandboxDbs', 'must be an array');
  cfg.sandboxDbs = cfg.sandboxDbs.map(expandHome);
  cfg.dataDir = expandHome(String(cfg.dataDir));
  return cfg;
}
