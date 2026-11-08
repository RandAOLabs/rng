// Throughput guard: the live beacon (protocol/beacon/anyhonest.lua, in the
// AOS wasm through ao-loader, as run-anyhonest-tests.mjs runs it) driven by
// three validators running the validator's own loop (createValidator, runLoop:
// plan, shouldReveal, batch, Close) against simulated HTTP round trips. Time is
// simulated and seeded; nothing reads the wall clock. 2026-11-07: revealing
// only at commitDeadline cut live throughput from ~1.2 to ~0.6 rounds/s and
// every test passed. These assert the speed: 2 rounds/s on average (the
// rhythm, targetIntervalMs 500), catch-up after a slow stretch, no overshoot.
//   node --test protocol/test/throughput.test.mjs
//   SIM_SWEEP='[[100,250],[150,400]]' [SIM_PARAMS='{"targetIntervalMs":0}'] ...   rate per round-trip range
//   SIM_LOG=1 ...                                                               every message
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AoLoader from '@permaweb/ao-loader';
import os from 'node:os';
import { createValidator, runLoop, shouldReveal } from '../../validator/anyhonest-validator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const AOS_WASM = process.env.AOS_WASM
  || path.join(process.env.PARALITH_ROOT || 'C:/REPO/paralith-mono', 'backend/native/module/AOS.wasm');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const addr = (s) => s.padEnd(43, '_');
const hexOf = (s) => '1' + sha(s).slice(1); // nonzero first digit, far below N

// The live round parameters (deploy/v3-params.json), short reveal window aside.
const LIVE = JSON.parse(read('deploy/v3-params.json'));
const COMMIT_WINDOW = LIVE.commitWindowMs; // 5000
const F = { owner: addr('owner'), sched: addr('scheduler'), token: addr('rng-token'), beacon: addr('timelock-beacon'),
  v: [addr('val-a'), addr('val-b'), addr('val-c')], unit: 1_000_000, T: 1024 };
const H = hexOf('h'), H_PROOF = hexOf('h-proof');
const CONFIG = { self: F.beacon, token: F.token, unit: F.unit, T: F.T, h: H, hProof: H_PROOF,
  commitWindowMs: COMMIT_WINDOW, revealWindowMs: LIVE.revealWindowMs, abandonAfterMs: LIVE.abandonAfterMs,
  minCommits: 2, cadenceMs: LIVE.cadenceMs, targetIntervalMs: LIVE.targetIntervalMs, maxInFlight: LIVE.maxInFlight,
  catchUpMs: LIVE.catchUpMs, heartbeat: 1, roundPrice: 1, requestPrice: 4, stake: 25000, slash: 1000,
  rejoinBaseMs: 60000, rejoinCapMs: 3600000, crackBounty: 10, predecessor: '' };

// The beacon in Lua: compute() per message, rng@1.0 answered from SimDev,
// which the simulated validators fill as they commit (only their own alpha
// opens their c).
const driver = `
local SELF = string.rep("b", 43)
SimDev = {}
SimDev["verify-crack|" .. G .. "|" .. "${F.T}" .. "|" .. "${H}" .. "|" .. "${H_PROOF}"] = { valid = true, y = "${H}" }
local FIELDS = { ["verify-reveal"] = { "c", "alpha", "h" }, ["verify-crack"] = { "x", "t", "y", "proof" } }
RngDeviceResolve = function(m)
  local key = (m.path:gsub("^/~rng@1.0/", ""))
  for _, f in ipairs(FIELDS[key] or {}) do key = key .. "|" .. tostring(m[f]) end
  local res = SimDev[key]
  if not res then return "ok", { valid = false, reason = "not in the sim" } end
  return "ok", res
end
SimBase = { ["scheduler-location"] = "${F.sched}", process = { commitments = { p = { type = "rsa-pss-sha512", committer = "${F.owner}" } } } }
SimSlot = 0
function SimSend(signer, fieldsJson, ts, fromProcess)
  local body = json.decode(fieldsJson)
  body.target = SELF
  body.commitments = { c = { type = "rsa-pss-sha256", committer = signer, committed = { "target", "data", "action" } } }
  if fromProcess then body["from-process"] = fromProcess end
  SimSlot = SimSlot + 1
  Owner = nil -- the beacon reads its owner from base.process; aos needs its own back for the next Eval
  SimBase = compute(SimBase, { body = body, timestamp = ts, process = SELF, slot = SimSlot })
  Owner = AosOwner
  return encode({ slot = SimSlot, out = SimBase.results.output.data or "", info = SimBase.beaconinfo,
    recent = SimBase.beaconrecent })
end
`;
const bundle = [
  read('protocol/vendor/json.lua'),
  'local jsonx = (function()', read('protocol/vendor/jsonenc.lua'), 'end)()',
  'encode, jsonObject = jsonx.encode, jsonx.object',
  'json = require(".json")',
  'AosOwner = Owner',
  'Owner = nil',
  'TestHarness = true',
  'rng = (function()', read('lib/rng.lua'), 'end)()',
  read('protocol/vendor/sha256.lua'),
  read('protocol/vendor/gov.lua'),
  read('protocol/beacon/anyhonest.lua'),
  driver,
  'Owner = AosOwner',
  'return "loaded"',
].join('\n');

async function loadBeacon() {
  const handle = await AoLoader(fs.readFileSync(AOS_WASM), { format: 'wasm32-unknown-emscripten', computeLimit: 9e12, memoryLimit: 512 * 1024 * 1024 });
  const pid = addr('throughput-sim');
  const env = { Process: { Id: pid, Owner: pid, Tags: [] }, Module: { Id: 'aos', Tags: [] } };
  let memory = null, n = 0;
  const evalLua = async (code) => {
    const r = await handle(memory, { Id: `sim-${n++}`, Target: pid, Owner: pid, From: pid, Tags: [{ name: 'Action', value: 'Eval' }],
      Data: code, 'Block-Height': '1', Timestamp: '1700000000000', Module: 'aos', Cron: false }, env);
    if (r.Error) throw new Error(String(r.Error));
    memory = r.Memory;
    const out = r.Output?.data;
    return typeof out === 'string' ? out : out?.output ?? JSON.stringify(out);
  };
  assert.match(await evalLua(bundle), /loaded/);
  const L = (s) => JSON.stringify(String(s)); // a JSON string is a valid Lua string literal here
  return {
    /** Compute one message at scheduler time ts; the beacon's published view after it. */
    async send(signer, fields, ts, { fromProcess, dev = [] } = {}) {
      const reg = dev.map(([k, y]) => `SimDev[${L(k)}] = { valid = true, y = ${L(y)} }`).join('\n');
      const raw = await evalLua(`${reg}\nreturn SimSend(${L(signer)}, ${L(JSON.stringify(fields))}, ${ts}, ${fromProcess ? L(fromProcess) : 'nil'})`);
      let r;
      try { r = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { throw new Error(`bad reply: ${raw.slice(0, 500)}`); }
      return { slot: r.slot, out: r.out ? JSON.parse(r.out) : {}, info: JSON.parse(r.info), recent: JSON.parse(r.recent) };
    },
  };
}

/** Deterministic PRNG (mulberry32). */
function rand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run the beacon for durationMs of simulated time with the validator's own
 * loop (createValidator().pass(), then intervalMs, as `run` does). Every HTTP
 * call (read or post) takes a round trip drawn from rtt(t) = [min, max] ms; the
 * node serves it halfway. opts: { silent: [index...] (never run), hold (a read
 * filter standing in for another reveal rule), seed, intervalMs }.
 */
async function simulate({ params = {}, durationMs = 60_000, silent = [], hold, seed = 7, rtt = () => [150, 400], intervalMs = 100, lanes = 2 } = {}) {
  const beacon = await loadBeacon();
  const rnd = rand(seed);
  let t = 1_700_000_000_000;
  const t0 = t;
  // Whole ms, even: the beacon takes integer timestamps and serves each call halfway.
  const trip = () => { const [lo, hi] = rtt(t - t0); return 2 * Math.round((lo + rnd() * (hi - lo)) / 2); };
  let view = null, sends = 0;
  const refused = {};
  const finalized = new Map(); // round -> { opened, finalizedAt, commitDeadline }
  const deadlines = new Map();
  const apply = async (signer, fields, ts, opts) => {
    view = await beacon.send(signer, fields, ts, opts);
    view.at = ts;
    sends++;
    const err = view.out?.error ?? view.out?.act?.map((x) => x.result?.error).filter(Boolean).join(',');
    if (err) refused[err] = (refused[err] ?? 0) + 1;
    for (const x of [view.info.open, ...view.info.revealing]) if (x.commitDeadline > 0) deadlines.set(x.round, x.commitDeadline);
    for (const r of view.recent) if (!finalized.has(r.round)) finalized.set(r.round, { ...r, commitDeadline: deadlines.get(r.round) });
    return view;
  };
  // Genesis and setup, 1 ms apart, before the clock starts.
  const step = () => (t += 1);
  await apply(F.owner, { Action: 'Gov.Configure', Data: JSON.stringify({ ...CONFIG, ...params }) }, step());
  let ref = 0;
  const credit = (tags) => apply(F.sched, { Action: 'Credit-Notice', Reference: `t${++ref}`, ...tags }, step(), { fromProcess: F.token });
  await credit({ Sender: F.owner, Quantity: String(1_000_000 * F.unit), 'X-Foundation': 'true' });
  await credit({ Sender: F.owner, Quantity: String(1_000 * F.unit), 'X-Treasury': 'true' });
  for (const v of F.v) await credit({ Sender: F.owner, Quantity: String(25_000 * F.unit), 'X-For': v, 'X-Bond': 'true' });
  for (const v of F.v) await apply(v, { Action: 'Ready' }, step());
  assert.equal(view.info.validators.filter((v) => v.ready).length, 3, `all three ready: ${JSON.stringify(refused)}`);
  assert.equal(view.info.mode, 'heartbeat');
  const start = t;

  // Event queue: [time, seq, fn]; ties run in insertion order.
  const queue = [];
  let seq = 0;
  const at = (time, fn) => {
    const e = [time, seq++, fn];
    let i = queue.length;
    while (i > 0 && (queue[i - 1][0] > time)) i--;
    queue.splice(i, 0, e);
  };
  const wait = (ms) => new Promise((res) => at(t + ms, res));
  // A read: served halfway through its round trip, answered at the end.
  const serve = (get) => new Promise((res) => {
    const rt = trip();
    at(t + rt / 2, () => { const v = get(); at(t + rt / 2, () => res(v)); });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rng-throughput-'));
  const stop = start + durationMs;
  const errors = [];
  F.v.forEach((me, i) => {
    if (silent.includes(i)) return;
    const dataDir = path.join(dir, String(i));
    const secretsOf = (r) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets', `${r}.json`), 'utf8')); } catch { return {}; } };
    const io = {
      now: () => t,
      readAtSlot: () => serve(() => view.slot),
      readInfo: () => serve(() => (hold ? hold(view.info, t) : view.info)),
      readKey: () => serve(() => null),
      transfer: () => Promise.reject(new Error('no transfers in the sim')),
      post: (pid, action, data) => new Promise((res) => {
        const rt = trip();
        at(t + rt / 2, async () => {
          // rng@1.0 opens this c with the alpha the validator saved for it.
          const c = action === 'Commit' ? data : data.commit;
          const dev = c ? [[`verify-reveal|${c.c}|${secretsOf(c.round)[c.c]}|${H}`, hexOf(`y|${c.c}`)]] : [];
          const v = await apply(me, { Action: action, Data: JSON.stringify(data) }, t, { dev });
          if (process.env.SIM_LOG) console.log(i, t - start, action, JSON.stringify(data).slice(0, 80), JSON.stringify(v.out).slice(0, 300));
          at(t + rt / 2, () => res(v.slot));
        });
      }),
    };
    const v = createValidator({ cfg: { beacon: F.beacon, dataDir }, me, io, log: (m) => process.env.SIM_LOG && console.log(i, t - start, m) });
    at(start + i * 37, () => runLoop(v, { interval: intervalMs, lanes, wait, until: () => t >= stop,
      onError: (e) => errors.push(`${i}: ${e.stack}`) }));
  });
  while (queue.length) {
    const [time, , fn] = queue.shift();
    t = Math.max(t, time);
    fn();
    await new Promise((res) => setImmediate(res)); // let the validator run up to its next call
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, [], 'validator loop errors');
  const rounds = [...finalized.values()].sort((x, y) => x.round - y.round);
  return { rounds, sends, refused, info: view.info, t0: start, end: stop };
}

/** Another reveal rule, by read filter: a revealing round reads as `held`
 *  (plan() skips it) until `ready(round, beaconNow)`. */
const holdUntil = (ready) => (info, now) => {
  const h = (x) => (x.phase === 'reveal' && !ready(x, now) ? { ...x, phase: 'held' } : x);
  return { ...info, open: h(info.open), revealing: info.revealing.map(h) };
};

/** Rounds finalized per second in [fromMs, toMs) of the run (from: the first
 *  round's open, the rhythm's start, by default), with their latencies. */
function measure(sim, { fromMs, toMs = sim.end - sim.t0 } = {}) {
  const from = sim.t0 + (fromMs ?? (sim.rounds[0]?.opened ?? sim.t0) - sim.t0), to = sim.t0 + toMs;
  const rs = sim.rounds.filter((r) => r.finalizedAt >= from && r.finalizedAt < to);
  const lat = rs.map((r) => r.finalizedAt - r.opened).sort((x, y) => x - y);
  const pct = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? NaN;
  return { rounds: rs.length, rate: rs.length / ((to - from) / 1000), p50: pct(0.5), p95: pct(0.95), max: lat.at(-1) ?? NaN };
}

const fmt = (m) => `${m.rate.toFixed(2)} rounds/s over ${m.rounds} rounds, latency p50 ${Math.round(m.p50)} ms, p95 ${Math.round(m.p95)} ms, max ${Math.round(m.max)} ms`;
const TARGET = 1000 / LIVE.targetIntervalMs; // 2 rounds/s, on average
const onTarget = (m, what) => assert.ok(Math.abs(m.rate - TARGET) <= 0.1, `${what}: ${m.rate.toFixed(3)} rounds/s, want ${TARGET} +- 0.1`);

if (process.env.SIM_SWEEP) test('sweep', async () => {
  for (const [lo, hi] of JSON.parse(process.env.SIM_SWEEP)) {
    const sim = await simulate({ durationMs: 60_000, rtt: () => [lo, hi], params: JSON.parse(process.env.SIM_PARAMS || '{}') });
    console.log(`rtt ${lo}-${hi}: ${fmt(measure(sim))}`);
  }
});

test('healthy, 100-250 ms round trips: 2 rounds/s on average, latency well under the commit window', async () => {
  const sim = await simulate({ durationMs: 60_000, rtt: () => [100, 250] });
  const m = measure(sim);
  console.log(`healthy 100-250 ms: ${fmt(m)}; ${sim.sends} messages; refused ${JSON.stringify(sim.refused)}`);
  onTarget(m, 'long-run average');
  assert.ok(m.p50 < COMMIT_WINDOW / 4, `p50 latency ${m.p50} ms not well below commitWindowMs ${COMMIT_WINDOW}`);
  assert.ok(m.max < COMMIT_WINDOW / 2, `max latency ${m.max} ms >= commitWindowMs / 2`);
  assert.equal(sim.info.health.status, 'ok', 'nobody faulted');
});

test('healthy, 150-400 ms round trips: at least the 1.8 rounds/s the live alert wants', async () => {
  // About the most these links carry (three commits per round, each a read
  // round trip behind the last close): ~1.9-1.95 rounds/s, no room to catch up.
  const sim = await simulate({ durationMs: 60_000, rtt: () => [150, 400] });
  const m = measure(sim);
  console.log(`healthy 150-400 ms: ${fmt(m)}`);
  assert.ok(m.rate >= 1.8 && m.rate <= TARGET + 0.05, `150-400 ms: ${m.rate.toFixed(3)} rounds/s`);
  assert.ok(m.max < COMMIT_WINDOW / 2, `max latency ${m.max} ms >= commitWindowMs / 2`);
});

test('a slow stretch: the rhythm catches back up to the 2 rounds/s average', async () => {
  // 100-250 ms round trips, 1.5-2.5 s for 15 s: lateness under catchUpMs (30 s), repaid in full.
  const slow = [20_000, 35_000];
  const sim = await simulate({ durationMs: 90_000, rtt: (ms) => (ms >= slow[0] && ms < slow[1] ? [1500, 2500] : [100, 250]) });
  const during = measure(sim, { fromMs: slow[0], toMs: slow[1] }), all = measure(sim);
  const after = measure(sim, { fromMs: slow[1], toMs: slow[1] + 20_000 });
  console.log(`slow stretch: ${during.rate.toFixed(2)} rounds/s during, ${after.rate.toFixed(2)} in the 20 s after, ${all.rate.toFixed(2)} on average (${all.rounds} rounds)`);
  assert.ok(during.rate < 1, `the stretch was not slow: ${during.rate.toFixed(2)} rounds/s`);
  assert.ok(after.rate > TARGET + 0.3, `no catch-up after the stretch: ${after.rate.toFixed(2)} rounds/s`);
  onTarget(all, 'average with the slow stretch');
});

test('very fast validators do not overshoot 2 rounds/s', async () => {
  const sim = await simulate({ durationMs: 30_000, rtt: () => [10, 30] });
  const m = measure(sim);
  console.log(`fast 10-30 ms: ${fmt(m)}`);
  assert.ok(m.rate <= TARGET + 0.05 && m.rate >= TARGET - 0.1, `fast: ${m.rate.toFixed(3)} rounds/s`);
});

test('one validator silent: its round finalizes right after the commit deadline, the average holds', async () => {
  const sim = await simulate({ durationMs: 45_000, silent: [2], rtt: () => [100, 250] });
  const first = sim.rounds[0];
  assert.ok(first, 'a round finalized');
  // Round 1 was given to all three: it closes at commitDeadline without C (A
  // or B sends Close), and A and B reveal straight away.
  const over = first.finalizedAt - first.commitDeadline;
  const m = measure(sim);
  console.log(`silent C: round ${first.round} finalized ${over} ms after its commit deadline; then ${fmt(m)}`);
  assert.ok(first.commitDeadline > 0 && over >= 0 && over < 2000, `round 1 finalized ${over} ms after commitDeadline`);
  onTarget(m, 'average with C silent');
  const c = sim.info.validators.find((v) => v.address === F.v[2]);
  assert.equal(c.ready, false, 'the silent validator was suspended');
});

test('the guard bites: revealing only at commitDeadline fails it', async () => {
  const sim = await simulate({ durationMs: 30_000, hold: holdUntil((x, now) => now >= Number(x.commitDeadline)) });
  const m = measure(sim);
  console.log(`old rule (reveal at commitDeadline): ${fmt(m)}`);
  assert.ok(m.rate < 1.8 && m.p50 >= COMMIT_WINDOW, `the old rule should fail the guard: ${fmt(m)}`);
});

test('shouldReveal: closed when the set is complete or the deadline passed', () => {
  const x = { active: ['a', 'b'], committed: { a: '1' }, commitDeadline: 1000 };
  assert.equal(shouldReveal(x, 999), false);
  assert.equal(shouldReveal(x, 1000), true);
  assert.equal(shouldReveal({ ...x, committed: { a: '1', b: '2' } }, 0), true);
  assert.equal(shouldReveal({ ...x, active: [] }, 0), false);
});
