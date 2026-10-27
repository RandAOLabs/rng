// Soak driver: many wallets and contracts using the beacon in different ways.
//
//   FUNDER_WALLET=funder.json node soak/run.mjs    (or HB_WALLET=owner.json to mint)
//
// Env (defaults): WALLETS=50 CONTRACTS=100 INITIAL_CONTRACTS=50
//   RATE=1 (actions/s) BURST_EVERY_MIN=60 BURST=60 (actions) HOURS=72
//   NEW_CONTRACT_EVERY_MIN=30 RAMP_MIN=60 (minutes to reach RATE)
//   CHAOS_EVERY_H=6 CHAOS_MIN=10 (0 = off). CHAOS=ssh rotates through all nodes
//   (needs deploy/nodes.local.sh); CHAOS=docker stops this host's own daemon
//   through /var/run/docker.sock.
// Everything it does is appended to soak/data/actions.jsonl for the checker.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import {
  BEACON, TIMELOCK, TOKEN, UNIT, ROOT, appendLine, env, loadFunder, log, pick, read, readJson, send, sleep,
  spawnConsumer, wallets as loadWallets, writeJson,
} from './common.mjs';

const N_WALLETS = env('WALLETS', 50);
const N_CONTRACTS = env('CONTRACTS', 100);
const N_INITIAL = env('INITIAL_CONTRACTS', 50);
const RATE = env('RATE', 1);
const BURST_EVERY = env('BURST_EVERY_MIN', 60) * 60_000;
const BURST = env('BURST', 60);
const HOURS = env('HOURS', 72);
const NEW_EVERY = env('NEW_CONTRACT_EVERY_MIN', 30) * 60_000;
const RAMP = env('RAMP_MIN', 60) * 60_000;
const CHAOS_EVERY = env('CHAOS_EVERY_H', 6) * 3_600_000;
const CHAOS_FOR = env('CHAOS_MIN', 10) * 60_000;
const MAX_IN_FLIGHT = env('MAX_IN_FLIGHT', 8);

const funder = loadFunder();
const owner = funder.jwk; // spawns the soak contracts and pays for funding
const CHAOS = process.env.CHAOS || 'ssh';
const ws = loadWallets(N_WALLETS + 1);
const pauper = ws.pop(); // never funded: its requests must be refused
const contracts = readJson('contracts.json', []);
const lastRequest = new Map(); // wallet -> { id, at } of its last request (for duplicates)
// The beacon remembers request ids for 200 rounds (SPEC.md); resend only well inside that.
const DUPLICATE_WITHIN_MS = 5 * 60_000;
let seq = Date.now();
const rid = (who) => `soak-${who.slice(0, 6)}-${(seq++).toString(36)}`;

async function record(kind, fields, fn) {
  const t = Date.now();
  try {
    const slot = await fn();
    appendLine('actions.jsonl', { t, kind, ...fields, slot });
  } catch (e) {
    appendLine('actions.jsonl', { t, kind, ...fields, sendError: e.message });
  }
}

const mint = (to, rng) => funder.mints
  ? send(owner, TOKEN, 'Admin.Mint', { Recipient: to, Quantity: String(rng * UNIT) })
  : send(owner, TOKEN, 'Transfer', { Recipient: to, Quantity: String(rng * UNIT) });
const fundBeacon = (jwk, forWho, rng, beacon = BEACON) => send(jwk, TOKEN, 'Transfer', { Recipient: beacon, Quantity: String(rng * UNIT), 'X-For': forWho });
const fundBoth = async (jwk, forWho, rng) => {
  await fundBeacon(jwk, forWho, rng, BEACON);
  if (TIMELOCK) await fundBeacon(jwk, forWho, rng, TIMELOCK);
};

async function setup() {
  log(`setup: ${ws.length} wallets, ${contracts.length}/${N_INITIAL} initial contracts`);
  const funded = readJson('funded.json', {});
  for (const w of ws) {
    if (funded[w.address]) continue;
    await mint(w.address, 2000);
    await sleep(500);
    await fundBoth(w.jwk, w.address, 300);
    funded[w.address] = true;
    writeJson('funded.json', funded);
  }
  while (contracts.length < N_INITIAL) await addContract();
}

async function addContract() {
  const pid = await spawnConsumer(owner);
  const funder = pick(ws);
  await fundBoth(funder.jwk, pid, 300);
  contracts.push({ pid, born: Date.now() });
  writeJson('contracts.json', contracts);
  appendLine('actions.jsonl', { t: Date.now(), kind: 'contract-born', pid });
  log(`contract ${contracts.length}: ${pid}`);
}

// One random action. Weights roughly: contracts 55% (quick, time-lock, local),
// direct requests 25% (quick, time-lock), edge cases 20%.
async function act() {
  const w = pick(ws);
  const r = Math.random();
  if (r < 0.20 && contracts.length) {
    const c = pick(contracts).pid;
    const count = 1 + Math.floor(Math.random() * 3);
    return record('play-beacon', { from: w.address, contract: c, count }, () => send(w.jwk, c, 'Play', { Count: String(count), Tier: 'quick' }));
  }
  if (r < 0.40 && contracts.length && TIMELOCK) {
    const c = pick(contracts).pid;
    const count = 1 + Math.floor(Math.random() * 3);
    return record('play-timelock', { from: w.address, contract: c, count }, () => send(w.jwk, c, 'Play', { Count: String(count), Tier: 'timelock' }));
  }
  if (r < 0.55 && contracts.length) {
    const c = pick(contracts).pid;
    const count = 1 + Math.floor(Math.random() * 5);
    return record('play-local', { from: w.address, contract: c, count }, () => send(w.jwk, c, 'Play', { Count: String(count), Tier: 'local' }));
  }
  if (r < 0.68 || (r < 0.80 && !TIMELOCK)) {
    const id = rid(w.address);
    lastRequest.set(w.address, { id, at: Date.now() });
    return record('direct', { from: w.address, requestId: id }, () => send(w.jwk, BEACON, 'Request-Random', { Tier: 'quick', 'Request-Id': id }));
  }
  if (r < 0.80) {
    const id = rid(w.address);
    return record('direct-timelock', { from: w.address, requestId: id }, () => send(w.jwk, TIMELOCK, 'Request-Random', { Tier: 'timelock', 'Request-Id': id }));
  }
  const last = lastRequest.get(w.address);
  if (r < 0.85 && last && Date.now() - last.at < DUPLICATE_WITHIN_MS) {
    const id = last.id;
    return record('duplicate', { from: w.address, requestId: id }, () => send(w.jwk, BEACON, 'Request-Random', { Tier: 'quick', 'Request-Id': id }));
  }
  if (r < 0.90) {
    const id = rid(pauper.address);
    return record('unfunded', { from: pauper.address, requestId: id }, () => send(pauper.jwk, BEACON, 'Request-Random', { Tier: 'quick', 'Request-Id': id }));
  }
  if (r < 0.95) return record('withdraw', { from: w.address }, () => send(w.jwk, BEACON, 'Withdraw', { Quantity: '1' }));
  return topUp();
}

// Keep balances from running dry: refill whoever is lowest.
async function topUp() {
  const all = [...ws.map((w) => w.address), ...contracts.map((c) => c.pid)];
  const beacons = [[BEACON, 'beaconstate'], ...(TIMELOCK ? [[TIMELOCK, 'timelockstate']] : [])];
  for (const [pid, key] of beacons) {
    const state = await read(pid, key);
    const low = all.filter((a) => (state.balances?.[a] ?? 0) < 60);
    for (const a of low.slice(0, 5)) {
      const funder = pick(ws);
      await mint(funder.address, 300);
      await record('top-up', { from: funder.address, for: a, beacon: pid }, () => fundBeacon(funder.jwk, a, 300, pid));
    }
  }
}

const CHAOS_CONTAINERS = (process.env.CHAOS_CONTAINERS || 'randao-provider,rng-validator').split(',');
function dockerApi(verb, container) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', method: 'POST', path: `/containers/${container}/${verb}` }, (res) => {
      res.resume();
      res.statusCode < 400 ? resolve() : reject(new Error(`docker ${verb}: HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function chaos(name, action) {
  try {
    if (CHAOS === 'docker') {
      for (const c of CHAOS_CONTAINERS) await dockerApi(action === 'stop-one' ? 'stop' : 'start', c).catch((e) => log(`chaos ${c}: ${e.message}`));
    }
    else execFileSync('bash', [path.join(ROOT, 'deploy', 'nodes.sh'), action, name], { stdio: 'pipe' });
    appendLine('actions.jsonl', { t: Date.now(), kind: `chaos-${action}`, node: name });
    log(`chaos: ${action} ${name}`);
  } catch (e) { log(`chaos ${action} ${name} failed: ${e.message.split('\n')[0]}`); }
}

async function main() {
  await setup();
  const start = Date.now();
  const end = start + HOURS * 3_600_000;
  let nextBurst = start + BURST_EVERY;
  let nextContract = start + NEW_EVERY;
  let nextChaos = CHAOS_EVERY > 0 ? start + CHAOS_EVERY : Infinity;
  const chaosNodes = CHAOS === 'docker' ? ['this-host'] : ['main', 'paralith', 'randao'];
  let chaosI = 0;
  let inFlight = 0;
  const fire = () => { inFlight++; act().catch((e) => log('act:', e.message)).finally(() => { inFlight--; }); };

  log(`running for ${HOURS} h at up to ${RATE}/s`);
  while (Date.now() < end) {
    const now = Date.now();
    const rate = Math.max(0.1, RATE * Math.min(1, (now - start) / RAMP));
    if (inFlight < MAX_IN_FLIGHT) fire();
    if (now >= nextBurst) {
      log(`burst: ${BURST} actions`);
      appendLine('actions.jsonl', { t: now, kind: 'burst', size: BURST });
      for (let i = 0; i < BURST; i++) fire();
      nextBurst = now + BURST_EVERY;
    }
    if (now >= nextContract && contracts.length < N_CONTRACTS) {
      nextContract = now + NEW_EVERY;
      await addContract().catch((e) => log('spawn:', e.message));
    }
    if (now >= nextChaos) {
      const name = chaosNodes[chaosI++ % chaosNodes.length];
      chaos(name, 'stop-one');
      setTimeout(() => chaos(name, 'start-one'), CHAOS_FOR);
      nextChaos = now + CHAOS_EVERY;
    }
    await sleep(1000 / rate);
  }
  log('soak finished');
}

main().catch((e) => { console.error(e); process.exit(1); });
