#!/usr/bin/env node
// Any-Honest beacon end to end on a LOCAL HyperBEAM node: a throwaway token
// and beacon (deploy.mjs, exactly as a deploy spawns them, on $RNG_DEVICE),
// three bonded validators running validator/anyhonest-validator.mjs, and paid
// requests (Transfer with X-Request-Id). Proves rounds advance and measures
// them. Never point it at a live node: it spawns and spends.
//
//   node deploy/anyhonest-e2e.mjs --image hbnode:<tag> [--port 18221] [--seconds 60]
//        [--every-ms 250] [--sample-ms 100] [--validators 3] [--fair N] [--keep]
//   ... --node http://<bench-node>:<port> --remote   a remote BENCH node (never a live one:
//     deploy/bench-target.mjs refuses those); deploy.mjs needs PARALITH_MONO for wasm-patch spawns
//
// --fair N: then spawns fair play (deploy.mjs spawn-fair / configure-fair, the
// deployer as a wallet game) and times N draws one after another: Fair.Open,
// the player's Fair.Commit, Fair.Reveal once the session is reveal-due, done
// when it is resolved (open sent -> resolved seen).
//
// Reports each request's round trip (Transfer sent -> the first read showing
// its round final), rounds finalized per second while requests arrive, the
// beacon's own round latency (beaconrecent: opened -> finalizedAt, scheduler
// time), and with --keep the node's per-action slot costs
// (/~hyperbuddy@1.0/slots) for the token and the beacon.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as hb from '../validator/vendor/hbclient.mjs';
import { commitHash, newSecret } from '../lib/js/fair-client.ts';
import { benchNode, startBenchNode } from './bench-target.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const IMAGE = arg('--image');
const PORT = Number(arg('--port', 18221));
const NODE = IMAGE ? `http://127.0.0.1:${PORT}` : benchNode(arg('--node', process.env.HB_NODE));
const SECONDS = Number(arg('--seconds', 60));
const EVERY_MS = Number(arg('--every-ms', 250));
const SAMPLE_MS = Number(arg('--sample-ms', 100));
const VALIDATORS = Number(arg('--validators', 3));
const FAIR = Number(arg('--fair', 0));
const UNIT = 1_000_000n;
const GUARD_MS = 600000;
const SEEN_BUCKET_MS = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const rsa = () => ({ kty: 'RSA', ...crypto.generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 65537 })
  .privateKey.export({ format: 'jwk' }) });
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rng-anyhonest-e2e-'));
log(`work dir ${dir}`);

// 0. With --image: a fresh single node that schedules and delivers locally.
const CONTAINER = 'rng-anyhonest-e2e';
if (IMAGE) await startBenchNode({ image: IMAGE, port: PORT, name: CONTAINER, dir, keep: process.argv.includes('--keep'), log });

// 1. Token and beacon through deploy.mjs, exactly as a deploy runs them.
const deployer = rsa();
fs.writeFileSync(path.join(dir, 'deployer.json'), JSON.stringify(deployer), { mode: 0o600 });
const statePath = path.join(dir, 'state.json');
const env = { ...process.env, HB_NODE: NODE, HB_WALLET: path.join(dir, 'deployer.json'), RNG_STATE: statePath };
const deploy = (...a) => execFileSync(process.execPath, [path.join(HERE, 'deploy.mjs'), ...a], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
const t0 = Date.now();
deploy('spawn-token', path.join(HERE, 'allocations-deployer.json'));
deploy('spawn-beacon');
deploy('genesis-configure', path.join(HERE, 'v3-params.json'));
deploy('fund-reserve', '1000000');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const { token, beacon } = state;
const device = state.processes[beacon].executionDevice;
log(`token ${token}, beacon ${beacon} on ${device} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

async function key(pid, k) {
  const r = await hb.readState({ node: NODE, process: pid, path: `now/${k}` });
  if (r.status !== 200 || /^\s*</.test(r.value || '')) return null;
  return JSON.parse(r.value);
}

// 2. Validators: a wallet each, bonded by the deployer, then `run`.
const validator = path.join(ROOT, 'validator', 'anyhonest-validator.mjs');
const vdirs = [];
const addresses = [];
for (let i = 1; i <= VALIDATORS; i++) {
  const vdir = path.join(dir, `validator-${i}`);
  const out = execFileSync(process.execPath, [validator, 'init', '--beacon', beacon, '--node', NODE, '--dir', vdir,
    '--listen', String(17580 + i)], { cwd: ROOT }).toString();
  addresses.push(JSON.parse(out).address);
  vdirs.push(vdir);
}
const stake = String(JSON.parse(fs.readFileSync(path.join(HERE, 'v3-params.json'), 'utf8')).stake);
deploy('bond-for', stake, ...addresses);
const procs = vdirs.map((vdir, i) => {
  const p = spawn(process.execPath, [validator, 'run', '--dir', vdir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(path.join(dir, `validator-${i + 1}.log`));
  p.stdout.pipe(out); p.stderr.pipe(out);
  return p;
});
const stop = () => { for (const p of procs) p.kill(); };
process.on('exit', stop);

// 3. Wait for the beacon to run rounds, then pay for requests at a steady rate.
for (let i = 0; ; i++) {
  const info = await key(beacon, 'beaconinfo').catch(() => null);
  if (info && info.round >= 2) { log(`beacon at round ${info.round}`); break; }
  if (i > 240) { stop(); throw new Error(`no rounds after 120 s (validators: ${dir})`); }
  await sleep(500);
}
const me = hb.jwkToAddress(deployer);
const price = BigInt((await key(beacon, 'beaconinfo')).price ?? 4);
const samples = []; // { at, round }
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const info = await key(beacon, 'beaconinfo').catch(() => null);
    if (info) samples.push({ at: Date.now(), round: info.round });
    await sleep(SAMPLE_MS);
  }
})();
const before = samples.at(-1)?.round ?? (await key(beacon, 'beaconinfo')).round;
log(`sending a paid request every ${EVERY_MS} ms for ${SECONDS} s`);
const sent = [];
const inflight = [];
const tEnd = Date.now() + SECONDS * 1000;
let n = 0;
while (Date.now() < tEnd) {
  const id = `ah-${++n}`;
  const at = Date.now();
  inflight.push(hb.sendMessage({ node: NODE, jwk: deployer, process: token, action: 'Transfer',
    tags: { Recipient: beacon, Quantity: String(price * UNIT), 'X-Request-Id': id } })
    .then(() => sent.push({ id, at }), (e) => log(`send ${id}: ${e.message}`)));
  await sleep(EVERY_MS);
}
await Promise.all(inflight);
log(`${sent.length} requests sent; waiting for every one to be served`);

// 4. Each request's round from the published `seen` buckets, then its round final.
async function boundRounds() {
  const now = Date.now();
  const first = Math.floor((sent[0].at - 5000 + GUARD_MS) / SEEN_BUCKET_MS);
  const last = Math.floor((now + 5000 + GUARD_MS) / SEEN_BUCKET_MS);
  const seen = {};
  for (let b = first; b <= last; b++) Object.assign(seen, (await key(beacon, `timelockseen-${b}`).catch(() => null)) || {});
  return seen;
}
const deadline = Date.now() + 180_000;
let seen = {};
let info;
for (;;) {
  seen = await boundRounds();
  info = await key(beacon, 'beaconinfo');
  const bound = sent.map((s) => seen[`${me}|${s.id}`]);
  if (bound.every((r) => r !== undefined) && Math.max(...bound.map(Number)) <= info.round) break;
  if (Date.now() > deadline) break;
  await sleep(500);
}
sampling = false;
await sampler.catch(() => {});
// The loop above can see the last round final before the sampler does: one
// last sample, so those requests count (at this later time, an upper bound).
samples.push({ at: Date.now(), round: info?.round ?? 0 });
const recent = await key(beacon, 'beaconrecent').catch(() => []) || [];

// 5. Fair draws, one at a time, while the beacon keeps running.
const fairMs = [];
let fair = null;
if (FAIR > 0) {
  deploy('spawn-fair');
  deploy('configure-fair');
  deploy('fund-fair', '40');
  deploy('fund-game', String(Number(price) * (FAIR + 2)), me);
  fair = JSON.parse(fs.readFileSync(statePath, 'utf8')).fair;
  const player = rsa();
  const playerAddress = hb.jwkToAddress(player);
  const sessionView = async (session) => {
    const all = await key(fair, 'fairsessions').catch(() => null);
    return (all?.[me] || []).find((v) => v.session === session && v.player === playerAddress) || null;
  };
  for (let i = 1; i <= FAIR; i++) {
    const session = `e2e-${i}`;
    const secret = newSecret();
    const at = Date.now();
    await hb.sendMessage({ node: NODE, jwk: deployer, process: fair, action: 'Fair.Open', tags: { Session: session, Player: playerAddress } });
    await hb.sendMessage({ node: NODE, jwk: player, process: fair, action: 'Fair.Commit',
      tags: { Game: me, Session: session, Commit: await commitHash(me, session, secret) } });
    let revealed = false;
    let poked = 0;
    const end = Date.now() + 120_000;
    for (;;) {
      const view = await sessionView(session);
      if (!revealed && view?.status === 'reveal-due') {
        await hb.sendMessage({ node: NODE, jwk: player, process: fair, action: 'Fair.Reveal',
          tags: { Game: me, Session: session, Secret: secret, Player: playerAddress } });
        revealed = true;
      } else if (revealed && (!view || view.status === 'revealed')) {
        fairMs.push(Date.now() - at);
        break;
      }
      // Fair sends a due beacon request when a message arrives (any Get-Info
      // pumps it); live, other games' traffic does that. Poke it once a second.
      if (view?.status === 'committed' && Date.now() - poked >= 1000) {
        poked = Date.now();
        hb.sendMessage({ node: NODE, jwk: deployer, process: fair, action: 'Get-Info' }).catch(() => {});
      }
      if (Date.now() > end) { log(`fair draw ${session} not resolved in 120 s (last ${view?.status})`); break; }
      await sleep(SAMPLE_MS);
    }
  }
}
stop();

const latencies = [];
const unserved = [];
for (const s of sent) {
  const r = Number(seen[`${me}|${s.id}`]);
  const hit = samples.find((x) => x.at >= s.at && x.round >= r);
  if (!Number.isFinite(r) || !hit) unserved.push(s.id); else latencies.push(hit.at - s.at);
}
const finalRound = info?.round ?? 0;
const first = samples.find((x) => x.round > before);
const last = samples.find((x) => x.round === finalRound) ?? samples.at(-1);
const spanS = first && last && last.at > first.at ? (last.at - first.at) / 1000 : null;
const rounds = finalRound - before;
const roundLatency = recent.filter((r) => r.opened && r.finalizedAt).map((r) => r.finalizedAt - r.opened);
const report = {
  node: NODE, beacon, device, validators: VALIDATORS, requests: sent.length, served: latencies.length,
  unserved: unserved.length, rounds, roundsPerSecond: spanS ? Number(((rounds - 1) / spanS).toFixed(3)) : null,
  roundTripMs: { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), max: pct(latencies, 1) },
  beaconRoundMs: { p50: pct(roundLatency, 0.5), p95: pct(roundLatency, 0.95), n: roundLatency.length },
  ...(FAIR ? { fair, fairDrawMs: { p50: pct(fairMs, 0.5), p95: pct(fairMs, 0.95), n: fairMs.length, of: FAIR } } : {}),
  workDir: dir,
};
if (process.argv.includes('--keep')) {
  const slots = await (await fetch(`${NODE}/~hyperbuddy@1.0/slots?window=600`)).json().catch(() => null);
  const role = { [token]: 'token', [beacon]: 'beacon', ...(fair ? { [fair]: 'fair' } : {}) };
  report.slots = (slots?.processes || []).filter((p) => role[p.pid]).map((p) => ({
    role: role[p.pid], slots: p.counters.slots,
    msPerSlot: Object.fromEntries(['exec_us', 'lua_us', 'decode_us', 'store_us'].map((k) => [k.replace('_us', ''),
      Number((p.counters[k] / Math.max(1, p.counters.slots) / 1000).toFixed(2))])),
    actions: Object.fromEntries(p.actions.map((a) => [a.action, { n: a.count, execMs: Number((a.exec_us / a.count / 1000).toFixed(2)) }])),
  }));
}
console.log(JSON.stringify(report, null, 1));
const ok = rounds > 1 && unserved.length === 0 && latencies.length === sent.length && fairMs.length === FAIR;
if (!ok) { console.error('FAIL: the beacon did not serve every paid request'); process.exit(1); }
console.log(`PASS: ${device} ${rounds} rounds, ${report.roundsPerSecond} rounds/s, request round trip p50 ${report.roundTripMs.p50} ms p95 ${report.roundTripMs.p95} ms`);
process.exit(0);
