#!/usr/bin/env node
// K Any-Honest beacons on ONE node at once, each with its own bonded
// validators, for capacity: how many beacons a node sustains, at what round
// latency. One throwaway token funds them all (deploy.mjs, as a deploy spawns
// them, on $RNG_DEVICE: wasm-patch@1.0 by default, RNG_DEVICE=lua-patch@1.0
// for Luerl). Beacon 1 also takes paid requests (Transfer with X-Request-Id)
// and is sampled finely for their round trip; every beacon's rounds are read
// from its own `beaconrecent` (opened -> finalizedAt, scheduler time).
// Spawns and spends: never a live node (deploy/bench-target.mjs).
//
//   node deploy/bench-beacons.mjs --image <tag> [--port 18261] [--keep]       a node of its own (docker, this box)
//   node deploy/bench-beacons.mjs --node http://<bench-node>:8734 --remote    a remote bench node
//     [--beacons 4] [--validators 3] [--seconds 120] [--warmup 30]
//     [--request-every-ms 500] [--sample-ms 200] [--setup-concurrency 4] [--out result.json]
//
// Validators run here, V node processes per beacon (~60 MB each). Report
// (stdout, and --out): per beacon rounds, rounds/s and round latency p50/p95;
// the aggregate; beacon 1's request round trip; the node's per-process slot
// costs (/~hyperbuddy@1.0/slots). A beacon `keeps up` when its rate is at
// least 90% of 1000 / targetIntervalMs (v3-params.json: 2 rounds/s).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as hb from '../validator/vendor/hbclient.mjs';
import { benchNode, startBenchNode } from './bench-target.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const IMAGE = arg('--image');
const PORT = Number(arg('--port', 18261));
const K = Number(arg('--beacons', 4));
const V = Number(arg('--validators', 3));
const SECONDS = Number(arg('--seconds', 120));
const WARMUP = Number(arg('--warmup', 30));
const REQUEST_EVERY_MS = Number(arg('--request-every-ms', 500));
const SAMPLE_MS = Number(arg('--sample-ms', 200));
const SETUP_CONCURRENCY = Number(arg('--setup-concurrency', 4));
const OUT = arg('--out');
const UNIT = 1_000_000n;
const GUARD_MS = 600000;
const SEEN_BUCKET_MS = 60000;
const PARAMS = JSON.parse(fs.readFileSync(path.join(HERE, 'v3-params.json'), 'utf8'));
const TARGET_RATE = 1000 / Number(PARAMS.targetIntervalMs || 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 23), ...a);
const rsa = () => ({ kty: 'RSA', ...crypto.generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 65537 })
  .privateKey.export({ format: 'jwk' }) });
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rng-bench-beacons-'));
log(`work dir ${dir}`);
const NODE = IMAGE
  ? await startBenchNode({ image: IMAGE, port: PORT, name: 'rng-bench-beacons', dir, keep: process.argv.includes('--keep'), log })
  : benchNode(arg('--node', process.env.HB_NODE));

// 1. The token, then K beacons, each from its own copy of the deploy state.
const deployer = rsa();
fs.writeFileSync(path.join(dir, 'deployer.json'), JSON.stringify(deployer), { mode: 0o600 });
const me = hb.jwkToAddress(deployer);
const deployIn = (state) => (...a) => run(process.execPath, [path.join(HERE, 'deploy.mjs'), ...a],
  { env: { ...process.env, HB_NODE: NODE, HB_WALLET: path.join(dir, 'deployer.json'), RNG_STATE: state }, cwd: ROOT,
    maxBuffer: 1 << 26 });
const tokenState = path.join(dir, 'state-token.json');
const t0 = Date.now();
await deployIn(tokenState)('spawn-token', path.join(HERE, 'allocations-deployer.json'));
const base = JSON.parse(fs.readFileSync(tokenState, 'utf8'));
log(`token ${base.token} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const validatorJs = path.join(ROOT, 'validator', 'anyhonest-validator.mjs');
const beacons = await pool(Array.from({ length: K }, (_, i) => i + 1), SETUP_CONCURRENCY, async (k) => {
  const state = path.join(dir, `state-beacon-${k}.json`);
  fs.writeFileSync(state, JSON.stringify(base));
  const deploy = deployIn(state);
  await deploy('spawn-beacon');
  await deploy('genesis-configure', path.join(HERE, 'v3-params.json'));
  await deploy('fund-reserve', '1000000');
  const pid = JSON.parse(fs.readFileSync(state, 'utf8')).beacon;
  const vdirs = [];
  const addresses = [];
  for (let i = 1; i <= V; i++) {
    const vdir = path.join(dir, `beacon-${k}-validator-${i}`);
    const { stdout } = await run(process.execPath, [validatorJs, 'init', '--beacon', pid, '--node', NODE, '--dir', vdir,
      '--listen', String(20000 + k * 16 + i)], { cwd: ROOT });
    addresses.push(JSON.parse(stdout).address);
    vdirs.push(vdir);
  }
  await deploy('bond-for', String(PARAMS.stake), ...addresses);
  log(`beacon ${k}/${K} ${pid} spawned, ${V} validators bonded`);
  return { k, pid, state, vdirs };
});
const device = JSON.parse(fs.readFileSync(beacons[0].state, 'utf8')).processes[beacons[0].pid].executionDevice;

// 2. Every validator runs.
const procs = [];
for (const b of beacons) {
  b.vdirs.forEach((vdir, i) => {
    const p = spawn(process.execPath, [validatorJs, 'run', '--dir', vdir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(path.join(dir, `beacon-${b.k}-validator-${i + 1}.log`));
    p.stdout.pipe(out); p.stderr.pipe(out);
    procs.push(p);
  });
}
const stopValidators = () => { for (const p of procs) p.kill(); };
process.on('exit', stopValidators);

async function key(pid, k) {
  const r = await hb.readState({ node: NODE, process: pid, path: `now/${k}` }).catch(() => null);
  if (!r || r.status !== 200 || /^\s*</.test(r.value || '')) return null;
  try { return JSON.parse(r.value); } catch { return null; }
}

// 3. Warm up: every beacon finalizing rounds (or the warm-up runs out).
const warmEnd = Date.now() + WARMUP * 1000 + 120_000;
for (;;) {
  const rounds = await Promise.all(beacons.map((b) => key(b.pid, 'beaconinfo').then((i) => i?.round ?? 0)));
  if (rounds.every((r) => r >= 2) || Date.now() > warmEnd) { log(`rounds at start: ${rounds.join(' ')}`); break; }
  await sleep(2000);
}
await sleep(WARMUP * 1000);

// 4. Measure: every beacon's rounds (beaconrecent every 2 s), beacon 1's paid requests.
for (const b of beacons) { b.rounds = new Map(); b.startRound = (await key(b.pid, 'beaconinfo'))?.round ?? 0; b.startAt = Date.now(); }
let measuring = true;
const roundReader = (async () => {
  while (measuring) {
    await Promise.all(beacons.map(async (b) => {
      for (const r of (await key(b.pid, 'beaconrecent')) || []) {
        if (r.round > b.startRound && r.opened && r.finalizedAt) b.rounds.set(r.round, r.finalizedAt - r.opened);
      }
    }));
    await sleep(2000);
  }
})();
const probe = beacons[0];
const samples = [];
const sampler = (async () => {
  while (measuring) {
    const info = await key(probe.pid, 'beaconinfo');
    if (info) samples.push({ at: Date.now(), round: info.round });
    await sleep(SAMPLE_MS);
  }
})();
const price = BigInt((await key(probe.pid, 'beaconinfo'))?.price ?? PARAMS.requestPrice ?? 4);
const sent = [];
const inflight = [];
const tEnd = Date.now() + SECONDS * 1000;
log(`measuring ${SECONDS} s: ${K} beacons x ${V} validators on ${device}` + (REQUEST_EVERY_MS > 0 ? `, a paid request to beacon 1 every ${REQUEST_EVERY_MS} ms` : ''));
let n = 0;
while (Date.now() < tEnd) {
  if (REQUEST_EVERY_MS > 0) {
    const id = `bench-${++n}`;
    const at = Date.now();
    inflight.push(hb.sendMessage({ node: NODE, jwk: deployer, process: base.token, action: 'Transfer',
      tags: { Recipient: probe.pid, Quantity: String(price * UNIT), 'X-Request-Id': id } })
      .then(() => sent.push({ id, at }), (e) => log(`send ${id}: ${e.message}`)));
    await sleep(REQUEST_EVERY_MS);
  } else {
    await sleep(1000);
  }
}
await Promise.all(inflight);
for (const b of beacons) { b.endRound = (await key(b.pid, 'beaconinfo'))?.round ?? b.startRound; b.endAt = Date.now(); }

// 5. Beacon 1's requests: bound round from the `timelockseen` buckets, then final.
let seen = {};
if (sent.length) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    seen = {};
    const first = Math.floor((sent[0].at - 5000 + GUARD_MS) / SEEN_BUCKET_MS);
    const last = Math.floor((Date.now() + 5000 + GUARD_MS) / SEEN_BUCKET_MS);
    for (let bk = first; bk <= last; bk++) Object.assign(seen, (await key(probe.pid, `timelockseen-${bk}`)) || {});
    const info = await key(probe.pid, 'beaconinfo');
    const bound = sent.map((s) => seen[`${me}|${s.id}`]);
    if (bound.every((r) => r !== undefined) && Math.max(...bound.map(Number)) <= (info?.round ?? 0)) {
      samples.push({ at: Date.now(), round: info.round });
      break;
    }
    if (Date.now() > deadline) break;
    await sleep(500);
  }
}
measuring = false;
await Promise.all([roundReader, sampler]);
const slots = await fetch(`${NODE}/~hyperbuddy@1.0/slots?window=600`).then((r) => r.json()).catch(() => null);
stopValidators();

const latencies = [];
let unserved = 0;
for (const s of sent) {
  const r = Number(seen[`${me}|${s.id}`]);
  const hit = samples.find((x) => x.at >= s.at && x.round >= r);
  if (!Number.isFinite(r) || !hit) unserved++; else latencies.push(hit.at - s.at);
}
const perBeacon = beacons.map((b) => {
  const ms = [...b.rounds.values()];
  const rate = (b.endRound - b.startRound) / ((b.endAt - b.startAt) / 1000);
  return { beacon: b.pid, rounds: b.endRound - b.startRound, roundsPerSecond: Number(rate.toFixed(3)),
    keepsUp: rate >= 0.9 * TARGET_RATE, roundMs: { p50: pct(ms, 0.5), p95: pct(ms, 0.95), n: ms.length } };
});
const allMs = beacons.flatMap((b) => [...b.rounds.values()]);
const roles = Object.fromEntries([[base.token, 'token'], ...beacons.map((b) => [b.pid, `beacon-${b.k}`])]);
const report = {
  node: NODE, image: IMAGE ?? null, device, beacons: K, validatorsPerBeacon: V, seconds: SECONDS,
  targetRoundsPerSecond: TARGET_RATE,
  aggregate: {
    roundsPerSecond: Number(perBeacon.reduce((a, b) => a + b.roundsPerSecond, 0).toFixed(3)),
    beaconsKeepingUp: perBeacon.filter((b) => b.keepsUp).length,
    roundMs: { p50: pct(allMs, 0.5), p95: pct(allMs, 0.95), n: allMs.length },
  },
  probe: { beacon: probe.pid, requests: sent.length, served: latencies.length, unserved,
    roundTripMs: { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), max: pct(latencies, 1) } },
  perBeacon,
  slots: (slots?.processes || []).filter((p) => roles[p.pid]).map((p) => ({
    role: roles[p.pid], slots: p.counters.slots,
    msPerSlot: Object.fromEntries(['exec_us', 'lua_us', 'store_us'].map((k) => [k.replace('_us', ''),
      Number((p.counters[k] / Math.max(1, p.counters.slots) / 1000).toFixed(2))])),
  })),
  workDir: dir,
};
const text = JSON.stringify(report, null, 1);
if (OUT) fs.writeFileSync(OUT, text);
console.log(text);
process.exit(0);
