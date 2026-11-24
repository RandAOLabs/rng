#!/usr/bin/env node
// Confirmed messages per second for one RNG process on a LOCAL node: spawn a
// throwaway token (deploy.mjs, on $RNG_DEVICE), then keep --concurrency
// signed Transfers in flight for --seconds; a message counts once the
// token's computed slot has reached it. Round trip is send -> computed.
//
//   node deploy/saturate.mjs --image hbnode:<tag> [--port 18241] [--seconds 30] [--concurrency 32]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as hb from '../validator/vendor/hbclient.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const IMAGE = arg('--image');
const PORT = Number(arg('--port', 18241));
const NODE = `http://127.0.0.1:${PORT}`;
if (!IMAGE) throw new Error('--image <local image>: this starts its own node');
const SECONDS = Number(arg('--seconds', 30));
const CONCURRENCY = Number(arg('--concurrency', 32));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rsa = () => ({ kty: 'RSA', ...crypto.generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 65537 })
  .privateKey.export({ format: 'jwk' }) });
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rng-saturate-'));
const CONTAINER = 'rng-saturate';
const docker = (...a) => execFileSync('docker', a, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).toString();
const lmdb = { 'store-module': 'hb_store_lmdb', name: '/app/cache-mainnet/lmdb', capacity: 8 * 1024 ** 3, sync: false,
  'ao-types': 'store-module="atom", capacity="integer"' };
const config = {
  'scheduling-mode': 'local_confirmation', 'scheduler-lookahead': false, 'scheduler-publish-remote': false,
  'force-signed': false, 'store-all-signed': false,
  'rate-limit-requests': 100000, 'rate-limit-period': 60, 'rate-limit-max': 100000, 'rate-limit-min': -100000,
  'process-snapshot-time': 900, 'process-snapshot-slots': 1000, 'process-snapshot-target': false,
  'process-delta-checkpoint-slots': 1000,
  store: [lmdb, { 'store-module': 'hb_store_fs', name: '/app/cache-mainnet', 'ao-types': 'store-module="atom"' }],
};
fs.mkdirSync(path.join(dir, 'node', 'keys'), { recursive: true });
fs.writeFileSync(path.join(dir, 'node', 'keys', 'node-key.json'), JSON.stringify(rsa()), { mode: 0o600 });
fs.writeFileSync(path.join(dir, 'node', 'node-config.json'), JSON.stringify(config));
try { docker('rm', '-f', CONTAINER); } catch { /* none */ }
docker('create', '--name', CONTAINER, '-p', `127.0.0.1:${PORT}:10000`, '-e', 'HB_PORT=10000',
  '-e', 'HB_KEY=/app/keys/node-key.json', '-e', 'HB_CONFIG=/app/node-config.json', '-e', 'HB_PRINT=error', IMAGE);
docker('cp', path.join(dir, 'node', 'keys'), `${CONTAINER}:/app/keys`);
docker('cp', path.join(dir, 'node', 'node-config.json'), `${CONTAINER}:/app/node-config.json`);
docker('start', CONTAINER);
process.on('exit', () => { try { docker('rm', '-f', CONTAINER); } catch { /* gone */ } });
for (let i = 0; ; i++) {
  try { if ((await fetch(`${NODE}/~meta@1.0/info/address`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* starting */ }
  if (i > 90) throw new Error(`${IMAGE} did not come up`);
  await sleep(1000);
}

const deployer = rsa();
fs.writeFileSync(path.join(dir, 'deployer.json'), JSON.stringify(deployer), { mode: 0o600 });
const statePath = path.join(dir, 'state.json');
const env = { ...process.env, HB_NODE: NODE, HB_WALLET: path.join(dir, 'deployer.json'), RNG_STATE: statePath };
execFileSync(process.execPath, [path.join(HERE, 'deploy.mjs'), 'spawn-token', path.join(HERE, 'allocations-deployer.json')],
  { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const token = state.token;
const device = state.processes[token].executionDevice;
const recipients = Array.from({ length: 64 }, (_, i) => crypto.createHash('sha256').update(`r${i}`).digest('base64url').slice(0, 43));

/** The token's computed slot (hyperbuddy's per-process slot log). */
async function computedSlot() {
  const r = await fetch(`${NODE}/~hyperbuddy@1.0/slots?pid=${token}`).then((x) => x.json()).catch(() => null);
  const p = (r?.processes || []).find((x) => x.pid === token);
  return Number.isFinite(Number(p?.computed_slot)) ? Number(p.computed_slot) : -1;
}

// Warm up: the process is computed before timing.
await hb.sendMessage({ node: NODE, jwk: deployer, process: token, action: 'Transfer', tags: { Recipient: recipients[0], Quantity: '1' } });
const sent = []; // { slot, at }
let stop = Date.now() + SECONDS * 1000;
let n = 0;
async function worker() {
  while (Date.now() < stop) {
    const at = Date.now();
    const id = ++n;
    try {
      const res = await hb.sendMessage({ node: NODE, jwk: deployer, process: token, action: 'Transfer',
        tags: { Recipient: recipients[id % recipients.length], Quantity: '1' } });
      sent.push({ slot: Number(res?.slot), at, acked: Date.now() });
    } catch { /* counted as not sent */ }
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const tSent = Date.now();
const maxSlot = Math.max(...sent.map((s) => s.slot).filter(Number.isFinite));
for (let i = 0; i < 600; i++) { if (await computedSlot() >= maxSlot) break; await sleep(100); }
const tDone = Date.now();
const acks = sent.map((s) => s.acked - s.at);
const report = {
  device, image: IMAGE, concurrency: CONCURRENCY, messages: sent.length,
  confirmedPerSecond: Number((sent.length / ((tDone - t0) / 1000)).toFixed(1)),
  scheduledPerSecond: Number((sent.length / ((tSent - t0) / 1000)).toFixed(1)),
  drainMs: tDone - tSent, sendAckMs: { p50: pct(acks, 0.5), p95: pct(acks, 0.95) },
};
console.log(JSON.stringify(report));
process.exit(0);
