// Soak driver: many wallets and contracts using the beacon in different ways.
//
//   HB_WALLET=owner.json node soak/run.mjs
//
// Env (defaults): WALLETS=50 CONTRACTS=100 INITIAL_CONTRACTS=50
//   RATE=1 (actions/s) BURST_EVERY_MIN=60 BURST=60 (actions) HOURS=72
//   NEW_CONTRACT_EVERY_MIN=30 RAMP_MIN=60 (minutes to reach RATE)
//   CHAOS_EVERY_H=6 CHAOS_MIN=10 (needs deploy/nodes.local.sh; 0 = off)
// Everything it does is appended to soak/data/actions.jsonl for the checker.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  BEACON, TOKEN, UNIT, ROOT, appendLine, env, loadOwner, log, pick, read, readJson, send, sleep,
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

const owner = loadOwner();
const ws = loadWallets(N_WALLETS + 1);
const pauper = ws.pop(); // never funded: its requests must be refused
const contracts = readJson('contracts.json', []);
const lastRequest = new Map(); // wallet -> last request id (for duplicates)
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

const mint = (to, rng) => send(owner, TOKEN, 'Admin.Mint', { Recipient: to, Quantity: String(rng * UNIT) });
const fundBeacon = (jwk, forWho, rng) => send(jwk, TOKEN, 'Transfer', { Recipient: BEACON, Quantity: String(rng * UNIT), 'X-For': forWho });

async function setup() {
  log(`setup: ${ws.length} wallets, ${contracts.length}/${N_INITIAL} initial contracts`);
  const funded = readJson('funded.json', {});
  for (const w of ws) {
    if (funded[w.address]) continue;
    await mint(w.address, 2000);
    await sleep(500);
    await fundBeacon(w.jwk, w.address, 300);
    funded[w.address] = true;
    writeJson('funded.json', funded);
  }
  while (contracts.length < N_INITIAL) await addContract();
}

async function addContract() {
  const pid = await spawnConsumer(owner);
  const funder = pick(ws);
  await fundBeacon(funder.jwk, pid, 300);
  contracts.push({ pid, born: Date.now() });
  writeJson('contracts.json', contracts);
  appendLine('actions.jsonl', { t: Date.now(), kind: 'contract-born', pid });
  log(`contract ${contracts.length}: ${pid}`);
}

// One random action. Weights roughly: contracts 55%, direct 25%, edge cases 20%.
async function act() {
  const w = pick(ws);
  const r = Math.random();
  if (r < 0.40 && contracts.length) {
    const c = pick(contracts).pid;
    const count = 1 + Math.floor(Math.random() * 3);
    return record('play-beacon', { from: w.address, contract: c, count }, () => send(w.jwk, c, 'Play', { Count: String(count), Tier: 'beacon' }));
  }
  if (r < 0.55 && contracts.length) {
    const c = pick(contracts).pid;
    const count = 1 + Math.floor(Math.random() * 5);
    return record('play-local', { from: w.address, contract: c, count }, () => send(w.jwk, c, 'Play', { Count: String(count), Tier: 'local' }));
  }
  if (r < 0.80) {
    const id = rid(w.address);
    lastRequest.set(w.address, id);
    return record('direct', { from: w.address, requestId: id }, () => send(w.jwk, BEACON, 'Request-Random', { Tier: 'beacon', 'Request-Id': id }));
  }
  if (r < 0.85 && lastRequest.has(w.address)) {
    const id = lastRequest.get(w.address);
    return record('duplicate', { from: w.address, requestId: id }, () => send(w.jwk, BEACON, 'Request-Random', { Tier: 'beacon', 'Request-Id': id }));
  }
  if (r < 0.90) {
    const id = rid(pauper.address);
    return record('unfunded', { from: pauper.address, requestId: id }, () => send(pauper.jwk, BEACON, 'Request-Random', { Tier: 'beacon', 'Request-Id': id }));
  }
  if (r < 0.95) return record('withdraw', { from: w.address }, () => send(w.jwk, BEACON, 'Withdraw', { Quantity: '1' }));
  return topUp();
}

// Keep balances from running dry: refill whoever is lowest.
async function topUp() {
  const state = await read(BEACON, 'beaconstate');
  const all = [...ws.map((w) => w.address), ...contracts.map((c) => c.pid)];
  const low = all.filter((a) => (state.balances?.[a] ?? 0) < 60);
  for (const a of low.slice(0, 5)) {
    const funder = pick(ws);
    await mint(funder.address, 300);
    await record('top-up', { from: funder.address, for: a }, () => fundBeacon(funder.jwk, a, 300));
  }
}

function chaos(name, action) {
  try {
    execFileSync('bash', [path.join(ROOT, 'deploy', 'nodes.sh'), action, name], { stdio: 'pipe' });
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
  const chaosNodes = ['main', 'paralith', 'randao'];
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
