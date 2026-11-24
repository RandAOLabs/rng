#!/usr/bin/env node
// Fast-tier end to end on a LOCAL HyperBEAM node: a throwaway token and fast
// tier, a fresh 2-of-3 DKG committee, the three real rng-provider daemons
// (validator/daemon.mjs), and paid requests. Proves rounds advance and
// measures them. Never point it at a live node: it spawns and spends.
//
//   node deploy/fast-e2e.mjs --image hbnode:<tag> [--port 18201] [--seconds 60] [--every-ms 250] [--sample-ms 250] [--keep]
//     starts its own node (docker container rng-fast-e2e) and removes it after
//   HB_NODE=http://127.0.0.1:<port> node deploy/fast-e2e.mjs ...
//     an already running local node; it must have an LMDB store, or it will
//     not deliver the token's Credit-Notice (push answers 421)
//
// Reports rounds finalized per second while requests keep arriving, and each
// request's round trip (Transfer sent -> its round's value published).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as bls from '../validator/bls.mjs';
import * as hb from '../validator/vendor/hbclient.mjs';
import { fastSeenKey, fastSeenRound } from '../lib/js/fast.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const IMAGE = arg('--image');
const PORT = Number(arg('--port', 18201));
const NODE = IMAGE ? `http://127.0.0.1:${PORT}` : process.env.HB_NODE;
if (!NODE || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(NODE)) {
  throw new Error('pass --image, or HB_NODE as a local node (http://127.0.0.1:<port>): this spawns and spends');
}
const SECONDS = Number(arg('--seconds', 60));
const EVERY_MS = Number(arg('--every-ms', 250));
const SAMPLE_MS = Number(arg('--sample-ms', 250)); // how often the round is read: the round trip's resolution
const UNIT = 1_000_000n;
const PRICE = 3n; // signerFee 1 x 2 signers + protocolFee 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const rsa = () => ({ kty: 'RSA', ...crypto.generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 65537 })
  .privateKey.export({ format: 'jwk' }) });
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rng-fast-e2e-'));
log(`work dir ${dir}`);

// 0. With --image: a fresh single node that schedules and delivers locally.
const CONTAINER = 'rng-fast-e2e';
const docker = (...a) => execFileSync('docker', a, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).toString();
if (IMAGE) {
  const lmdb = { 'store-module': 'hb_store_lmdb', name: '/app/cache-mainnet/lmdb', capacity: 8 * 1024 ** 3, sync: false,
    'ao-types': 'store-module="atom", capacity="integer"' };
  const config = {
    'scheduling-mode': 'local_confirmation', 'scheduler-lookahead': false, 'scheduler-publish-remote': false,
    'force-signed': false, 'store-all-signed': false,
    'rate-limit-requests': 100000, 'rate-limit-period': 60, 'rate-limit-max': 100000, 'rate-limit-min': -100000,
    // The production nodes' snapshot cadence (paralith-mono infra/nodes/node-config.v011.json): the
    // default snapshots a process every slot, which for wasm-patch is its whole linear memory.
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
  if (!process.argv.includes('--keep')) process.on('exit', () => { try { docker('rm', '-f', CONTAINER); } catch { /* gone */ } });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${NODE}/~meta@1.0/info/address`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* starting */ }
    if (i > 90) throw new Error(`${IMAGE} did not come up; docker logs ${CONTAINER}`);
    await sleep(1000);
  }
  log(`node ${IMAGE} up at ${NODE}`);
}

// 1. Keys: the deployer, three provider wallets, a fresh 2-of-3 DKG.
const deployer = rsa();
fs.writeFileSync(path.join(dir, 'deployer.json'), JSON.stringify(deployer), { mode: 0o600 });
const deals = [1, 2, 3].map(() => bls.dkgDeal(3, 2));
const commitments = Object.fromEntries(deals.map((d, i) => [i + 1, d.commitments]));
const shares = [1, 2, 3].map((j) => bls.dkgFinish(j, 3, 2, Object.fromEntries(deals.map((d, i) => [i + 1, d.shares[j]])), commitments));
const wallets = [1, 2, 3].map(() => rsa());
const members = wallets.map((w) => hb.jwkToAddress(w));
const committee = { t: 2, groupKey: shares[0].groupKey, members, sharePublicKeys: [1, 2, 3].map((i) => shares[0].sharePublicKeys[i]) };
fs.writeFileSync(path.join(dir, 'committee.json'), JSON.stringify(committee));

// 2. Token and fast tier through deploy.mjs, exactly as the redeploy runs them.
const statePath = path.join(dir, 'state.json');
const env = { ...process.env, HB_NODE: NODE, HB_WALLET: path.join(dir, 'deployer.json'), RNG_STATE: statePath };
const deploy = (...a) => execFileSync(process.execPath, [path.join(HERE, 'deploy.mjs'), ...a], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
const t0 = Date.now();
deploy('spawn-token', path.join(HERE, 'allocations-deployer.json'));
deploy('spawn-fast');
deploy('genesis-configure-fast', path.join(dir, 'committee.json'));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const { token, fast } = state;
log(`token ${token}, fast ${fast} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

async function key(k) {
  const r = await hb.readState({ node: NODE, process: fast, path: `now/${k}` });
  if (r.status !== 200 || /^\s*</.test(r.value || '')) return null;
  return JSON.parse(r.value);
}

// 3. The three daemons, each with its own share and wallet.
const daemons = [];
for (let i = 1; i <= 3; i++) {
  const data = path.join(dir, `member-${i}`);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'share.json'), JSON.stringify(shares[i - 1]), { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'provider-wallet.json'), JSON.stringify(wallets[i - 1]), { mode: 0o600 });
  const cfg = path.join(dir, `member-${i}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ index: i, n: 3, t: 2, beacon: fast, hbNode: NODE, listen: 17480 + i, dataDir: data, peers: [] }));
  const p = spawn(process.execPath, [path.join(ROOT, 'validator', 'daemon.mjs'), 'run', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(path.join(dir, `member-${i}.log`));
  p.stdout.pipe(out); p.stderr.pipe(out);
  daemons.push(p);
}
const stop = () => { for (const p of daemons) p.kill(); };
process.on('exit', stop);

// 4. Paid requests (pay and request in one Transfer) at a steady rate, while
//    sampling the fast tier's round.
const me = hb.jwkToAddress(deployer);
const sent = []; // { id, at }
const samples = []; // { at, round }
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const info = await key('beaconinfo').catch(() => null);
    if (info) samples.push({ at: Date.now(), round: info.round, pending: info.pendingCount });
    await sleep(SAMPLE_MS);
  }
})();

const before = (await key('beaconinfo'))?.round ?? 0;
log(`fast round ${before}; sending a paid request every ${EVERY_MS} ms for ${SECONDS} s`);
const tEnd = Date.now() + SECONDS * 1000;
const inflight = [];
let n = 0;
while (Date.now() < tEnd) {
  const id = `e2e-${++n}`;
  const at = Date.now();
  inflight.push(hb.sendMessage({ node: NODE, jwk: deployer, process: token, action: 'Transfer',
    tags: { Recipient: fast, Quantity: String(PRICE * UNIT), 'X-Request-Id': id } })
    .then(() => sent.push({ id, at }), (e) => log(`send ${id}: ${e.message}`)));
  await sleep(EVERY_MS);
}
await Promise.all(inflight);
log(`${sent.length} requests sent; waiting for every one to be served`);

// 5. Every request bound to a round, every round finalized.
const deadline = Date.now() + 180_000;
let st;
for (;;) {
  st = await key('beaconstate');
  // Each shard still needed, read once (a shard holds many requests).
  const need = [...new Set(sent.filter((x) => x.round === undefined).map((x) => fastSeenKey(me, x.id)))];
  const shards = Object.fromEntries(await Promise.all(need.map(async (k) => [k, await key(k)])));
  for (const x of sent) if (x.round === undefined) x.round = fastSeenRound(shards[fastSeenKey(me, x.id)], me, x.id);
  const bound = sent.map((x) => x.round);
  if (bound.every((r) => r !== undefined) && Math.max(...bound.map(Number)) <= st.round) break;
  if (Date.now() > deadline) break;
  await sleep(500);
}
sampling = false;
await sampler.catch(() => {});
stop();

// Round trip per request: sent -> the first sample at which its round was final.
const latencies = [];
const unserved = [];
for (const s of sent) {
  const r = Number(s.round);
  const hit = samples.find((x) => x.at >= s.at && x.round >= r);
  if (!Number.isFinite(r) || !hit) unserved.push(s.id); else latencies.push(hit.at - s.at);
}
const finalRound = st?.round ?? 0;
const first = samples.find((x) => x.round > before);
const last = samples.find((x) => x.round === finalRound) ?? samples.at(-1);
const spanS = first && last && last.at > first.at ? (last.at - first.at) / 1000 : null;
const rounds = finalRound - before;
const report = {
  node: NODE, fast, requests: sent.length, served: latencies.length, unserved: unserved.length,
  rounds, roundsPerSecond: spanS ? Number(((rounds - 1) / spanS).toFixed(3)) : null,
  requestsPerRound: rounds ? Number((latencies.length / rounds).toFixed(2)) : null,
  roundTripMs: { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), max: pct(latencies, 1) },
  signerAccrued: st?.accrued, protocolAccrued: st?.protocolAccrued, abandoned: (st?.history || []).filter((h) => h[2] === 'abandoned').length,
  workDir: dir,
};
console.log(JSON.stringify(report, null, 1));
const ok = rounds > 1 && unserved.length === 0 && latencies.length === sent.length;
if (!ok) { console.error('FAIL: the fast tier did not serve every paid request'); process.exit(1); }
console.log(`PASS: ${rounds} fast rounds, ${report.roundsPerSecond} rounds/s, request round trip p50 ${report.roundTripMs.p50} ms p95 ${report.roundTripMs.p95} ms`);
process.exit(0);
