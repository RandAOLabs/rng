// Shared by the soak driver and checker: config, files, AO helpers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnProcess, sendMessage, readState, jwkToAddress } from '../vendor/hbclient.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.SOAK_DATA || path.join(ROOT, 'soak', 'data');
fs.mkdirSync(path.join(DATA, 'wallets'), { recursive: true });

export const testnet = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy', 'testnet.json'), 'utf8'));
export const NODE = process.env.HB_NODE || testnet.node;
export const BEACON = testnet.beacon;
export const TOKEN = testnet.token;
export const UNIT = 1_000_000;

export const env = (name, fallback) => (process.env[name] === undefined ? fallback : Number(process.env[name]));
export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
export const sha256hex = (s) => crypto.createHash('sha256').update(s, 'latin1').digest('hex');

export function readJson(file, fallback) {
  const p = path.join(DATA, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
}
export function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(value, null, 1));
}
export function appendLine(file, value) {
  fs.appendFileSync(path.join(DATA, file), JSON.stringify(value) + '\n');
}
export function readLines(file) {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** The wallet that funds the soak: FUNDER_WALLET (pre-funded TEST-RNG, pays by
 *  transfer, safe to put on a server) or HB_WALLET (the token owner, mints). */
export function loadFunder() {
  const file = process.env.FUNDER_WALLET || process.env.HB_WALLET;
  if (!file) throw new Error('set FUNDER_WALLET (pre-funded) or HB_WALLET (token owner)');
  return { jwk: JSON.parse(fs.readFileSync(file, 'utf8')), mints: !process.env.FUNDER_WALLET };
}

/** n soak wallets, generated once and kept in soak/data/wallets. */
export function wallets(n) {
  const dir = path.join(DATA, 'wallets');
  const out = [];
  for (let i = 0; i < n; i++) {
    const file = path.join(dir, `w${i}.json`);
    if (!fs.existsSync(file)) {
      const jwk = crypto.generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 65537 }).privateKey.export({ format: 'jwk' });
      fs.writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
    }
    const jwk = JSON.parse(fs.readFileSync(file, 'utf8'));
    out.push({ i, jwk, address: jwkToAddress(jwk) });
  }
  return out;
}

export async function send(jwk, pid, action, tags = {}, data) {
  const { slot } = await sendMessage({ node: NODE, jwk, process: pid, action, tags, data });
  return Number(slot);
}

export async function read(pid, key) {
  const r = await readState({ node: NODE, process: pid, path: `now/${key}` });
  if (r.status !== 200) throw new Error(`${key}: HTTP ${r.status}`);
  return JSON.parse(r.value);
}

export async function spawnConsumer(owner) {
  const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const lua = [
    src('vendor/json.lua'),
    'local jsonx = (function()', src('vendor/jsonenc.lua'), 'end)()',
    'local encode, jsonObject = jsonx.encode, jsonx.object',
    'rng = (function()', src('lib/rng.lua'), 'end)()',
    src('soak/consumer.lua'),
  ].join('\n');
  const pid = await spawnProcess({ node: NODE, jwk: owner, lua, name: 'RNG-Soak-Consumer' });
  await send(owner, pid, 'Configure', {}, JSON.stringify({ beacon: BEACON, self: pid }));
  return pid;
}
