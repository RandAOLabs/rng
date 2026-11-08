// Live end-to-end smoke test of a deployed RNG v3, through the same client
// code third parties use: lib/js (@randao/rng: fair-client, history),
// validator/vendor (hbclient httpsig, ans104 wallet signing), validator's
// anyhonest.mjs / bls.mjs verifiers and deploy.mjs's rate helpers.
//
//   node deploy/smoke.mjs [--n N] [--only A,B,...] [--load 30] [--fast-load 30] [--games 3] [--cap RNG]
//   node deploy/smoke.mjs --gov-plan        print the governance/bond plan (never runs; see below)
//   node deploy/deploy.mjs smoke [--n N] ...
//
// Scenarios (each N runs, default 10):
//   A  Any-Honest pay-and-request from a wallet (ANS-104, as the site's console):
//      the value from the round record, the round re-verified (reveals or cracks,
//      locally and with the node's ~rng@1.0 as the site does; value derivation)
//   B  Any-Honest prepaid: one deposit (X-For), signed Request-Randoms paid at the
//      deposit price, values verified, the leftover withdrawn
//   C  a spawned consumer process (protocol/test/request-consumer.lua) requests and
//      receives the RNG-Result push; verified
//   D  Fast tier pay-and-request and prepaid: the 2-of-3 BLS signature against the
//      group key, value and per-request derivation (site/lib/rng.ts)
//   E  fair play, --games games in parallel (this wallet and game processes it spawns
//      and funds: protocol/test/fair-game.lua): fund-game, Fair.Open, a throwaway player
//      key commits through FairClient, reveals once due, final checked against the hash
//      rule and the beacon value; one forfeit (no reveal, Fair.Expire after the window);
//      leftovers withdrawn
//   F  negatives: replayed signed Transfer and Request-Random (no double charge),
//      a reused Request-Id, insufficient balance, malformed requests, dust
//   G  load: a burst of --load concurrent pay-and-requests; validators fault-free,
//      the beacon on pace (5-minute average 1.8-2.2 rounds/s)
//   H  fast-tier load: a burst of --fast-load concurrent pay-and-requests, all signed
//
// Safety: every message goes through guard(): only the token, beacon, fast tier,
// fair process and processes this run spawned are written to; no Gov.*, DAO,
// Exit or bond message is ever sent; Transfers go only to the beacon, the fast
// tier or the fair process, and their total is capped (--cap, at most 10,000 RNG):
// the run aborts before a Transfer that would pass it. Leftover balances are
// withdrawn at the end.
//
// Report: a table on stdout, JSON in deploy/smoke-reports/<timestamp>.json.
// Env: HB_NODE, HB_WALLET, RNG_STATE (default deploy/v3-mainnet.json).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as hb from '../validator/vendor/hbclient.mjs';
import { signDataItem } from '../validator/vendor/ans104.mjs';
import * as ah from '../validator/anyhonest.mjs';
import * as bls from '../validator/bls.mjs';
import { findRound, httpReader } from '../lib/js/history.ts';
import { fastRequestPreimage } from '../lib/js/derive.ts';
import {
  FairClient, FairError, memoryStore, fairOpenTags, fairExpireTags, fairWithdrawTags, fairFundTags,
  payAndRequestTags, findRequest, verifySession, sessionValue, finalValue, forfeitValue, requestValue, fairRevealTags,
} from '../lib/js/fair-client.ts';
import { UNIT, historyPoint, beaconRate } from './deploy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const HARD_CAP_RNG = 10_000;
const ON_PACE = [1.8, 2.2];

class BudgetError extends Error {}
/** A verification the protocol itself failed: stops its scenario. */
class ProtocolIssue extends Error {}

/** p-th percentile (nearest rank) of a list of numbers, or null. */
export function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Run fn(i) for i < n, at most `conc` at once, until stop() says so. */
async function pool(n, conc, fn, stop = () => false) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, n)) }, async () => {
    while (next < n && !stop()) await fn(next++);
  }));
}

export async function main({ args = process.argv.slice(2), node = process.env.HB_NODE, jwk, state } = {}) {
  if (args.includes('--gov-plan')) { console.log(JSON.stringify(GOVERNANCE_PLAN, null, 1)); return null; }
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
  const N = Number(opt('--n', 10));
  const LOAD = Number(opt('--load', 30));
  const FAST_LOAD = Number(opt('--fast-load', 30));
  const GAMES = Math.max(1, Number(opt('--games', 3)));
  const CAP = Math.min(HARD_CAP_RNG, Number(opt('--cap', HARD_CAP_RNG)));
  const only = opt('--only', null) ? new Set(opt('--only').toUpperCase().split(',')) : null;
  if (!Number.isSafeInteger(N) || N < 1 || !Number.isSafeInteger(LOAD) || LOAD < 1 || !(CAP > 0)) throw new Error('bad --n / --load / --cap');
  if (!node) throw new Error('HB_NODE is required');
  node = node.replace(/\/$/, '');
  jwk ||= JSON.parse(fs.readFileSync(process.env.HB_WALLET || '', 'utf8'));
  state ||= JSON.parse(fs.readFileSync(path.resolve(process.env.RNG_STATE || path.join(HERE, 'v3-mainnet.json')), 'utf8'));
  const me = hb.jwkToAddress(jwk);
  const { token, beacon, fast, fair } = state;
  for (const [k, v] of Object.entries({ token, beacon, fast, fair })) if (!/^[A-Za-z0-9_-]{43}$/.test(v || '')) throw new Error(`state has no ${k}`);
  const actual = await hb.nodeAddress(node);
  if (actual !== state.scheduler) throw new Error(`node scheduler ${actual} is not the deployment's ${state.scheduler}`);

  const runTag = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rid = (s, i) => `smoke-${runTag}-${s}-${i}`;
  const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

  // ------------------------------------------------------------ safety
  const PAYEES = new Set([beacon, fast, fair]);
  const targets = new Set([token, beacon, fast, fair]); // + spawned test processes
  const spent = { grossAtoms: 0n, returnedAtoms: 0n, transfers: 0 };
  const FORBIDDEN = /^(gov\.|propose$|vote$|exit|bond|dao|stake|unstake|claim)/i;
  function guard(target, tags) {
    if (!targets.has(target)) throw new Error(`guard: ${target} is not a process this test may write to`);
    const action = String(tags.Action ?? tags.action ?? '');
    if (FORBIDDEN.test(action)) throw new Error(`guard: action ${action} is never sent by the smoke test`);
    for (const k of Object.keys(tags)) if (/^x-(bond|foundation|treasury)$/i.test(k)) throw new Error(`guard: tag ${k} is never sent`);
    if (target !== token || !/^transfer$/i.test(action)) return 0n;
    if (!PAYEES.has(tags.Recipient)) throw new Error(`guard: Transfer to ${tags.Recipient} refused (only beacon, fast, fair)`);
    const q = /^[1-9][0-9]*$/.test(String(tags.Quantity)) ? BigInt(tags.Quantity) : 0n;
    if (spent.grossAtoms + q > BigInt(CAP) * BigInt(UNIT)) {
      throw new BudgetError(`spend cap: this Transfer of ${Number(q) / UNIT} RNG would take the run past ${CAP} RNG`
        + ` (${Number(spent.grossAtoms) / UNIT} sent so far)`);
    }
    spent.grossAtoms += q;
    spent.transfers += 1;
    return q;
  }

  // ------------------------------------------------------------ transport
  async function readJson(pid, p) {
    const r = await hb.readState({ node, process: pid, path: p });
    if (r.status !== 200 || /^\s*</.test(r.value || '')) return null;
    try { return JSON.parse(r.value); } catch { return r.value; }
  }
  const key = (pid, k) => readJson(pid, `now/${k}`);
  const cache = new Map();
  /** One read serves every waiter for `ttl` ms (the site's anyHonestCache). */
  function cachedKey(pid, k, ttl = 400) {
    const id = `${pid}/${k}`;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = key(pid, k).catch(() => null);
    cache.set(id, { at: Date.now(), value });
    return value;
  }
  const output = (pid, slot) => readJson(pid, `compute&slot=${slot}/results/output/data`);
  const refund = (q, out) => { if (q > 0n && out && typeof out === 'object' && out.error) { spent.grossAtoms -= q; spent.transfers -= 1; } };

  /** Signed with httpsig (validator/vendor/hbclient), settled as deploy.mjs does. */
  async function hsend(pid, tags, data, as = jwk) {
    const q = guard(pid, tags);
    const { slot } = await hb.sendMessage({ node, jwk: as, process: pid, tags, data });
    await hb.awaitComputedSlot({ node, process: pid, slot });
    const out = await output(pid, slot);
    if (pid === token) refund(q, out);
    return { slot: Number(slot), out };
  }

  /** Signed as a browser wallet's signDataItem (ANS-104), sent as site/lib/wallet.ts does. */
  async function wsend(pid, tags, { signed, charge = true } = {}) {
    const q = charge ? guard(pid, tags) : (guard(pid, { Action: 'none' }), 0n);
    const bytes = signed ?? await signDataItem(jwk, { data: '', target: pid,
      tags: Object.entries(tags).map(([name, value]) => ({ name, value: String(value) })) });
    const base = `${node}/${pid}~process@1.0`;
    const res = await fetch(`${base}/schedule?codec-device=ans104@1.0`, { method: 'POST',
      headers: { 'content-type': 'application/ans104', 'accept-bundle': 'true' }, body: bytes, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      if (pid === token && q > 0n) { spent.grossAtoms -= q; spent.transfers -= 1; }
      const e = new Error(`the node refused the message (${res.status}): ${(await res.text()).replace(/\s+/g, ' ').slice(0, 160)}`);
      e.status = res.status;
      e.bytes = bytes;
      throw e;
    }
    const slot = Number(res.headers.get('slot'));
    const pushed = await fetch(`${base}/push&slot=${slot}`, { signal: AbortSignal.timeout(120_000) });
    if (!pushed.ok) throw new Error(`push of slot ${slot} failed (${pushed.status})`);
    await hb.awaitComputedSlot({ node, process: pid, slot });
    const out = await output(pid, slot);
    if (pid === token) refund(q, out);
    return { slot, out, bytes };
  }
  const tokenRefusal = (out) => (out && typeof out === 'object' && out.error ? out.error : null);
  async function tokenBalance() {
    const r = await hb.readState({ node, process: token, path: `now/balance-${me}` });
    return r.status === 200 && /^\d+$/.test(r.value.trim()) ? BigInt(r.value.trim()) : null;
  }

  // ------------------------------------------------------------ Any-Honest reads and checks
  const ahReader = httpReader(node, beacon);
  /** The round an Any-Honest request was bound to, from `timelockseen-<bucket>`. */
  async function ahSeen(requester, id, t0, timeoutMs = 30_000) {
    const want = `${requester}|${id}`;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const lo = Math.floor((t0 + 600_000) / 60_000) - 1, hi = Math.floor((Date.now() + 600_000) / 60_000) + 1;
      for (let b = lo; b <= hi; b++) {
        const part = await cachedKey(beacon, `timelockseen-${b}`, 300);
        if (part && typeof part === 'object' && part[want] !== undefined) return Number(part[want]);
      }
      await sleep(500);
    }
    throw new Error(`request ${id} is not bound to any round after ${timeoutMs / 1000} s (no timelockseen entry)`);
  }
  /** The finalized record of `round`: the live key, else history (site findAnyHonestRound). */
  async function ahRecord(round, timeoutMs = 120_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const live = await cachedKey(beacon, `beaconround-${round % 8}`, 300);
      if (live && Number(live.round) === round) return { record: live, slot: null };
      const info = await cachedKey(beacon, 'beaconinfo', 500);
      if (info && (Number(live?.round) > round || Number(info.round) > round + 4)) {
        const hit = await findRound(ahReader, { round, indexKey: 'timelockhistory',
          keys: (r) => [`beaconround-${r % 8}`, 'beaconabandoned'], scan: 64 });
        if (hit?.abandoned) throw new Error(`round ${round} was abandoned (requests refunded)`);
        if (hit) return { record: hit.record, slot: hit.slot };
      }
      await sleep(400);
    }
    throw new Error(`round ${round} did not finalize within ${timeoutMs / 1000} s`);
  }
  /** Re-check a round as the site does: each output (reveal or crack) and the value. */
  async function verifyAH(record, { device = false } = {}) {
    const problems = [];
    const addrs = Object.keys(record.commits || {}).sort();
    if (addrs.length < 2) problems.push(`only ${addrs.length} commits`);
    await Promise.all(addrs.map(async (a) => {
      const o = record.outputs?.[a];
      if (!o) { problems.push(`no output for ${a}`); return; }
      if (ah.checkOutput(record.commits[a], o, record.T, record.h) !== o.y) problems.push(`${o.via} of ${a} fails local verification`);
      if (!device) return;
      const u = new URL(`${node}/~rng@1.0/${o.via === 'reveal' ? 'verify-reveal' : 'verify-crack'}`);
      if (o.via === 'reveal') { u.searchParams.set('c', record.commits[a]); u.searchParams.set('alpha', o.alpha ?? ''); u.searchParams.set('h', record.h); }
      else { u.searchParams.set('x', record.commits[a]); u.searchParams.set('t', String(record.T)); u.searchParams.set('y', o.y); u.searchParams.set('proof', o.proof ?? ''); }
      const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
      if (![true, 'true'].includes(r.valid) || r.y !== o.y) problems.push(`~rng@1.0 ${o.via} check of ${a}: ${JSON.stringify(r).slice(0, 120)}`);
    }));
    const ys = addrs.map((a) => record.outputs?.[a]?.y).join('|');
    if (sha256(`hyperbeam/rng/any-honest/v1/round|${beacon}|${record.round}|${ys}`) !== record.value) problems.push('round value does not derive from the outputs');
    return { ok: problems.length === 0, problems, via: addrs.map((a) => record.outputs?.[a]?.via) };
  }
  /** A wallet/process request served in its round: value rechecked, round verified. */
  async function ahServed(requester, id, round, { device = false } = {}) {
    const { record, slot } = await ahRecord(round);
    const hits = (Array.isArray(record.requests) ? record.requests : []).filter((r) => r.requester === requester && r.requestId === id);
    if (hits.length !== 1) throw new ProtocolIssue(`request ${id} bound to round ${round}, but its record lists it ${hits.length} times`);
    const found = await findRequest([record], requester, id);
    if (!found?.valid) throw new ProtocolIssue(`round ${round}: value of ${id} is not H(request|value|requester|id)`);
    const v = await verifyAH(record, { device });
    if (!v.ok) throw new ProtocolIssue(`round ${round} fails verification: ${v.problems.join('; ')}`);
    return { round, value: found.value, roundValue: record.value, via: v.via.join(','), fromHistory: slot !== null };
  }

  // ------------------------------------------------------------ fast tier reads and checks
  const fastReader = httpReader(node, fast);
  async function fastSeen(requester, id, timeoutMs = 30_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const st = await cachedKey(fast, 'beaconstate', 500);
      const r = st?.seen?.[`${requester}|${id}`];
      if (r !== undefined) return Number(r);
      await sleep(500);
    }
    throw new Error(`fast request ${id} is not bound to a round after ${timeoutMs / 1000} s`);
  }
  async function fastServed(requester, id, round, timeoutMs) {
    const end = Date.now() + timeoutMs;
    let info;
    while (Date.now() < end) {
      info = await cachedKey(fast, 'beaconinfo', 1000);
      if (info && Number(info.round) >= round) break;
      await sleep(1000);
    }
    if (!(Number(info?.round) >= round)) {
      throw new Error(`fast round ${round} not signed within ${timeoutMs / 1000} s (round ${info?.round}, locked ${info?.lockedRound},`
        + ` pending ${info?.pendingCount}, abandonAt ${info?.abandonAt ? new Date(info.abandonAt).toISOString() : '?'})`);
    }
    const hit = await findRound(fastReader, { round, indexKey: 'beaconhistory', keys: () => ['beaconround', 'beaconabandoned'] });
    if (!hit) throw new ProtocolIssue(`fast round ${round} finalized but no beaconround record is found in its history`);
    if (hit.abandoned) throw new Error(`fast round ${round} was abandoned (requests refunded)`);
    const rec = hit.record;
    const problems = [];
    const message = `hyperbeam/rng/v1|${fast}|${round}`;
    const groupKey = rec.groupKey ?? info.groupKey;
    if (rec.message !== message) problems.push(`message ${rec.message} is not ${message}`);
    if (groupKey !== info.groupKey) problems.push('signed under a group key other than the published one');
    let sigOk = false;
    try { sigOk = bls.verify(groupKey, message, rec.signature); } catch (e) { problems.push(`BLS: ${e.message}`); }
    if (!sigOk) problems.push('BLS signature does not verify under the group key');
    if (sha256(`hyperbeam/rng/v1/round|${message}|${String(rec.signature).toLowerCase()}`) !== rec.value) problems.push('value is not H(round|message|signature)');
    const members = new Set((info.committee || []).map((m) => m.address));
    if (!Array.isArray(rec.signers) || rec.signers.length < info.threshold || !rec.signers.every((s) => members.has(s))) {
      problems.push(`signers ${JSON.stringify(rec.signers)} are not ${info.threshold} committee members`);
    }
    const mine = (rec.requests || []).filter((r) => r.requester === requester && r.requestId === id);
    if (mine.length !== 1) problems.push(`request ${id} listed ${mine.length} times`);
    else if (mine[0].value !== sha256(fastRequestPreimage(rec, requester, id))) problems.push(`request value is not ${rec.derivation ?? 'v1'} H(...)`);
    if (problems.length) throw new ProtocolIssue(`fast round ${round}: ${problems.join('; ')}`);
    return { round, value: mine[0].value, signers: rec.signers.join(','), slot: hit.slot };
  }

  // ------------------------------------------------------------ pace and validator health
  async function liveRate() {
    const [now, history, recent] = await Promise.all([key(beacon, 'beaconinfo'), key(beacon, 'timelockhistory'), key(beacon, 'beaconrecent')]);
    // The node keeps only a few thousand slots of history (older slots answer 410), which
    // is about the 5-minute point: fall back to shorter windows and say which one was used.
    for (const windowMs of [300_000, 240_000, 180_000, 120_000]) {
      const point = historyPoint(history, { windowMs });
      const then = point ? await readJson(beacon, `compute&slot=${point[1]}/beaconinfo`).catch(() => null) : null;
      if (then && typeof then === 'object') return { ...beaconRate({ then, now, recent }), round: now?.round, at: now?.at, wantedWindowMs: windowMs };
    }
    return { ...beaconRate({ then: null, now, recent }), round: now?.round, at: now?.at, wantedWindowMs: null };
  }
  const validatorView = (info) => Object.fromEntries((info?.validators || []).map((v) => [v.address,
    { faults: v.faults, strikes: v.strikes, suspended: v.suspended, active: v.active, exiting: v.exiting }]));

  // ------------------------------------------------------------ report
  const report = { startedAt: new Date().toISOString(), node, wallet: me, runTag, n: N, load: LOAD, capRng: CAP,
    processes: { token, beacon, fast, fair }, spawned: [], scenarios: [], preflight: null, spend: null };
  const reportDir = path.join(HERE, 'smoke-reports');
  const reportFile = path.join(reportDir, `${report.startedAt.replace(/[:.]/g, '-')}.json`);
  const save = () => { fs.mkdirSync(reportDir, { recursive: true }); fs.writeFileSync(reportFile, JSON.stringify(report, null, 1) + '\n'); };

  async function scenario(name, title, fn) {
    if (only && !only.has(name)) return;
    const sc = { name, title, runs: [], checks: [], issue: null, error: null };
    report.scenarios.push(sc);
    log(`== ${name}: ${title}`);
    const t0 = Date.now();
    try { await fn(sc); } catch (e) {
      if (e instanceof BudgetError) { sc.error = e.message; throw e; }
      sc.error = e.message;
      log(`   ${name} stopped: ${e.message}`);
    }
    const ms = sc.runs.filter((r) => r.ok).map((r) => r.ms);
    Object.assign(sc, { pass: sc.runs.filter((r) => r.ok).length + sc.checks.filter((c) => c.ok).length,
      total: sc.runs.length + sc.checks.length, p50: pct(ms, 50), p95: pct(ms, 95), max: ms.length ? Math.max(...ms) : null,
      wallMs: Date.now() - t0 });
    save();
  }
  /** One timed run; a ProtocolIssue stops the scenario. */
  async function run(sc, label, fn) {
    if (sc.issue) return null;
    const t0 = Date.now();
    try {
      const detail = await fn();
      sc.runs.push({ label, ok: true, ms: Date.now() - t0, detail });
      return detail;
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      sc.runs.push({ label, ok: false, ms: Date.now() - t0, error: e.message });
      if (e instanceof ProtocolIssue) sc.issue = e.message;
      log(`   ${label} FAILED: ${e.message}`);
      return null;
    }
  }
  const check = (sc, label, ok, detail) => { sc.checks.push({ label, ok: !!ok, detail }); if (!ok) log(`   check ${label} FAILED: ${JSON.stringify(detail)}`); };

  // ------------------------------------------------------------ preflight
  const startBalance = await tokenBalance();
  const [ahInfo, fastInfo, fairInfo, rate0] = await Promise.all([key(beacon, 'beaconinfo'), key(fast, 'beaconinfo'), key(fair, 'fairinfo'), liveRate()]);
  const ahPrice = Number(ahInfo?.price), fastPrice = Number(fastInfo?.price?.fast);
  report.preflight = { tokenBalanceAtoms: String(startBalance), beaconRound: ahInfo?.round, health: ahInfo?.health,
    ahPrice, fastPrice, fastRound: fastInfo?.round, fairPriceAtoms: fairInfo?.requestPriceAtoms, fairWindowMs: fairInfo?.fairWindowMs, rate: rate0 };
  log(`wallet ${me} balance ${Number(startBalance) / UNIT} RNG; beacon round ${ahInfo?.round} (${ahInfo?.health?.status}),`
    + ` rate ${rate0.rate?.toFixed(2)}/s; prices any-honest ${ahPrice}, fast ${fastPrice}; cap ${CAP} RNG`);
  if (ahInfo?.token !== token || fastInfo?.token !== token || fairInfo?.token !== token) throw new Error('a protocol is not configured on the token');
  if (!(ahPrice >= 1) || !(fastPrice >= 1)) throw new Error('prices unreadable');
  if (startBalance === null || startBalance < BigInt(CAP) * BigInt(UNIT)) throw new Error('wallet balance below the cap');
  const ahAtoms = BigInt(ahPrice) * BigInt(UNIT), fastAtoms = BigInt(fastPrice) * BigInt(UNIT);
  const rng = (n) => String(BigInt(n) * BigInt(UNIT));

  /** A test process's bundle (as deploy.mjs's subscriptionConsumerSource): json + the file, placeholders filled. */
  const testSource = (file) => [
    fs.readFileSync(path.join(ROOT, 'protocol/vendor/json.lua'), 'utf8'),
    'local jsonx = (function()', fs.readFileSync(path.join(ROOT, 'protocol/vendor/jsonenc.lua'), 'utf8'), 'end)()',
    'local encode, jsonObject = jsonx.encode, jsonx.object',
    fs.readFileSync(path.join(ROOT, 'protocol/test', file), 'utf8'),
  ].join('\n').replaceAll('__BEACON__', beacon).replaceAll('__FAIR__', fair).replaceAll('__OWNER__', me)
    .replaceAll('__SCHEDULER__', state.scheduler);

  /** Free balance back from the beacon or the fast tier (Insufficient-Balance: there was none). */
  async function withdrawAll(pid) {
    const { out } = await hsend(pid, { Action: 'Withdraw' });
    if (out?.withdrawn > 0) spent.returnedAtoms += BigInt(out.withdrawn) * BigInt(UNIT);
    return out;
  }

  try {
    // ---------------------------------------------------------- A
    await scenario('A', 'Any-Honest pay-and-request (wallet, ANS-104)', async (sc) => {
      await pool(N, 5, (i) => run(sc, `A${i}`, async () => {
        const id = rid('A', i);
        const t0 = Date.now();
        const { out } = await wsend(token, payAndRequestTags(beacon, ahAtoms, id));
        if (tokenRefusal(out)) throw new Error(`token refused: ${tokenRefusal(out)}`);
        const round = await ahSeen(me, id, t0);
        return ahServed(me, id, round, { device: true });
      }), () => !!sc.issue);
    });

    // ---------------------------------------------------------- B
    await scenario('B', 'Any-Honest prepaid balance (deposit, Request-Random, withdraw)', async (sc) => {
      const extra = 3;
      const dep = await hsend(token, { Action: 'Transfer', Recipient: beacon, Quantity: rng(N * ahPrice + extra), 'X-For': me });
      check(sc, 'deposit accepted by the token', !tokenRefusal(dep.out), dep.out);
      const replies = [];
      await pool(N, 5, (i) => run(sc, `B${i}`, async () => {
        const id = rid('B', i);
        const { out } = await hsend(beacon, { Action: 'Request-Random', 'Request-Id': id });
        if (out?.error) throw new Error(`beacon refused: ${out.error}`);
        replies.push(out);
        if (Number(out.price) !== ahPrice) throw new ProtocolIssue(`charged ${out.price}, deposit price was ${ahPrice}`);
        return { ...(await ahServed(me, id, Number(out.round))), price: out.price, balanceAfter: out.balance };
      }), () => !!sc.issue);
      const balances = replies.map((r) => Number(r.balance));
      const charged = replies.reduce((s, r) => s + Number(r.price), 0);
      check(sc, 'credits consumed at the deposit price', charged === replies.length * ahPrice
        && new Set(balances).size === balances.length, { charged, requests: replies.length, balances: balances.sort((a, b) => b - a) });
      const w = await withdrawAll(beacon);
      check(sc, `leftover withdrawn (>= ${extra} RNG)`, Number(w?.withdrawn) >= extra, w);
    });

    // ---------------------------------------------------------- C
    await scenario('C', 'process consumer receives the RNG-Result push', async (sc) => {
      const lua = testSource('request-consumer.lua');
      const consumer = await hb.spawnProcess({ node, jwk, lua, scheduler: state.scheduler, executionDevice: 'lua@5.3a', name: 'RNG-Smoke-Consumer' });
      targets.add(consumer);
      report.spawned.push({ role: 'request-consumer', pid: consumer, sourceSha256: sha256(lua) });
      log(`   consumer ${consumer}`);
      const dep = await hsend(token, { Action: 'Transfer', Recipient: beacon, Quantity: rng(N * ahPrice), 'X-For': consumer });
      check(sc, 'consumer funded (X-For)', !tokenRefusal(dep.out), dep.out);
      await pool(N, 20, (i) => run(sc, `C${i}`, async () => {
        const id = rid('C', i);
        await hsend(consumer, { Action: 'Request', 'Request-Id': id });
        const end = Date.now() + 120_000;
        let got = null;
        while (!got && Date.now() < end) {
          const st = await cachedKey(consumer, 'consumerstate', 500);
          if (st?.errors?.[id]) throw new Error(`beacon answered RNG-Error ${st.errors[id]}`);
          got = st?.results?.[id] ?? null;
          if (!got) await sleep(700);
        }
        if (!got) throw new Error(`no RNG-Result for ${id} within 120 s`);
        if (got.from !== beacon) throw new ProtocolIssue(`RNG-Result from ${got.from}, not the beacon`);
        if (await requestValue(got.roundValue, consumer, id) !== got.value) throw new ProtocolIssue(`pushed value for ${id} is not H(request|round value|consumer|id)`);
        const served = await ahServed(consumer, id, Number(got.round));
        if (served.roundValue !== got.roundValue || served.value !== got.value) throw new ProtocolIssue(`pushed result differs from round ${got.round}'s record`);
        return served;
      }), () => !!sc.issue);
      const st = await key(consumer, 'consumerstate');
      check(sc, 'no forged pushes accepted (rejected = 0)', Number(st?.rejected || 0) === 0, { rejected: st?.rejected, received: st?.received });
    });

    // ---------------------------------------------------------- D
    await scenario('D', 'Fast tier (2-of-3 BLS): pay-and-request and prepaid', async (sc) => {
      const wait = 180_000;
      await pool(N, 20, (i) => run(sc, `D-pay${i}`, async () => {
        const id = rid('Dp', i);
        const { out } = await wsend(token, payAndRequestTags(fast, fastAtoms, id));
        if (tokenRefusal(out)) throw new Error(`token refused: ${tokenRefusal(out)}`);
        return fastServed(me, id, await fastSeen(me, id), wait);
      }), () => !!sc.issue);
      if (sc.issue) return;
      const extra = 1;
      const dep = await hsend(token, { Action: 'Transfer', Recipient: fast, Quantity: rng(N * fastPrice + extra), 'X-For': me });
      check(sc, 'fast deposit accepted', !tokenRefusal(dep.out), dep.out);
      const replies = [];
      await pool(N, 5, (i) => run(sc, `D-pre${i}`, async () => {
        const id = rid('Dq', i);
        const { out } = await hsend(fast, { Action: 'Request-Random', 'Request-Id': id });
        if (out?.error) throw new Error(`fast tier refused: ${out.error}`);
        replies.push(out);
        if (Number(out.price) !== fastPrice) throw new ProtocolIssue(`charged ${out.price}, deposit price was ${fastPrice}`);
        return { ...(await fastServed(me, id, Number(out.round), wait)), price: out.price };
      }), () => !!sc.issue);
      check(sc, 'fast credits consumed at the deposit price', replies.every((r) => Number(r.price) === fastPrice), replies.map((r) => r.balance));
      const w = await withdrawAll(fast);
      check(sc, `fast leftover withdrawn (>= ${extra} RNG)`, Number(w?.withdrawn) >= extra, w);
    });

    // ---------------------------------------------------------- E
    await scenario('E', `fair play: ${GAMES} games in parallel (this wallet + game processes), throwaway player keys`, async (sc) => {
      const fairPrice = BigInt(fairInfo.requestPriceAtoms);
      // Game 0 is this wallet; the others are game processes this run spawns
      // (protocol/test/fair-game.lua), which also get the Fair-Result push; a wallet
      // game reads its result from fairsessions.
      const games = [{ address: me }];
      for (let g = 1; g < GAMES; g++) {
        const lua = testSource('fair-game.lua');
        const pid = await hb.spawnProcess({ node, jwk, lua, scheduler: state.scheduler, executionDevice: 'lua@5.3a', name: 'RNG-Smoke-Fair-Game' });
        targets.add(pid);
        report.spawned.push({ role: 'fair-test-game', pid, sourceSha256: sha256(lua) });
        games.push({ address: pid, process: true });
      }
      log(`   games ${games.map((g) => g.address.slice(0, 8)).join(', ')}`);
      const per = games.map((_, g) => Array.from({ length: N }, (_, i) => i).filter((i) => i % GAMES === g).length + (g === 0 ? 1 : 0));
      for (const [g, game] of games.entries()) {
        if (!per[g]) continue;
        const fund = await hsend(token, fairFundTags(fair, game.address, fairPrice * BigInt(per[g])));
        check(sc, `game ${g} funded (X-Fair-Game, ${per[g]} draws)`, !tokenRefusal(fund.out), fund.out);
      }
      const rounds = new Map(); // round -> verified record (cached per batch)
      const beaconLink = async (view) => {
        if (!rounds.has(view.round)) rounds.set(view.round, ahServed(fair, view.requestId, Number(view.round)));
        const served = await rounds.get(view.round);
        if (served.value !== view.beaconValue) throw new ProtocolIssue(`session ${view.session}: beaconValue is not the beacon's value for ${view.requestId}`);
        return served;
      };
      const session = async (i, forfeit) => {
        const s = `smoke-${runTag}-${forfeit ? 'forfeit' : i}`;
        const game = games[forfeit ? 0 : i % GAMES];
        const me = game.address; // the game, in the fair-client calls below
        const client = new FairClient({ fair, node, store: memoryStore() });
        const player = await client.player();
        if (game.process) await hsend(game.address, { Action: 'Open', Session: s, Player: player });
        else {
          const open = await hsend(fair, fairOpenTags(s, player));
          if (open.out?.error) throw new Error(`Fair.Open refused: ${open.out.error}`);
        }
        const saved = await client.commit(me, s);
        const end = Date.now() + 240_000;
        let view = null;
        while (Date.now() < end) {
          if (!forfeit) {
            const st = await client.step(saved);
            if (st.step === 'done') {
              if (!st.check.ok) throw new ProtocolIssue(`session ${s}: ${st.check.problems.join('; ')}`);
              view = st.view;
              break;
            }
          } else {
            view = (await client.sessions(me)).find((x) => x.session === s && x.player === player) ?? null;
            if (view?.status === 'reveal-due' && Date.now() > view.revealBy + 2000) {
              try { await client.send(fairExpireTags(me, s, player)); } catch (e) { if (!(e instanceof FairError && e.code === 'Not-Expired')) throw e; }
            }
            if (view?.status === 'forfeit') break;
            // Never client.step here: it would reveal. A Get-Info sends a due request.
            if (view?.status === 'committed') {
              const info = await client.info();
              if (!info.outstanding && Date.now() >= (info.requestAfter ?? 0)) await client.send({ Action: 'Get-Info' });
            }
          }
          await sleep(2000);
        }
        if (!view || !['revealed', 'forfeit'].includes(view.status)) throw new Error(`session ${s} not resolved within 240 s (status ${view?.status})`);
        const v = await sessionValue(view.beaconValue, me, s);
        const want = forfeit ? await forfeitValue(v) : await finalValue(v, saved.secret);
        if (view.v !== v || view.final !== want) throw new ProtocolIssue(`session ${s}: final ${view.final} is not the hash rule's ${want}`);
        if (forfeit && view.status !== 'forfeit') throw new ProtocolIssue(`session ${s} should be a forfeit, is ${view.status}`);
        const check2 = await verifySession(view, forfeit ? null : saved.secret);
        if (!check2.ok) throw new ProtocolIssue(`session ${s}: ${check2.problems.join('; ')}`);
        const served = await beaconLink(view);
        if (game.process) { // the Fair-Result push reached the game process
          const pend = Date.now() + 60_000;
          let got = null;
          while (!got && Date.now() < pend) { got = (await cachedKey(game.address, 'gamestate', 1000))?.results?.[s]; if (!got) await sleep(1000); }
          if (!got) throw new Error(`game process got no Fair-Result for ${s} within 60 s`);
          if (got.final !== view.final || got.status !== view.status) throw new ProtocolIssue(`Fair-Result for ${s} differs from the session: ${JSON.stringify(got)}`);
        }
        return { game: me, session: s, status: view.status, batch: view.batch, round: view.round, final: view.final, charged: view.charged, beaconRound: served.round };
      };
      await Promise.all([
        run(sc, 'E-forfeit', () => session(0, true)),
        pool(N, 20, (i) => run(sc, `E${i}`, () => session(i, false)), () => !!sc.issue),
      ]);
      const client = new FairClient({ fair, node, store: memoryStore() });
      for (const [g, game] of games.entries()) {
        const acct = await client.account(game.address);
        if (!acct || acct.reserved !== 0) { check(sc, `game ${g} account settled`, false, acct); continue; }
        if (acct.balance <= 0) { check(sc, `game ${g} account settled`, true, acct); continue; }
        if (game.process) { // back to the spawned game process, not this wallet
          await hsend(game.address, { Action: 'Withdraw', Nonce: String((acct.nonce || 0) + 1) });
          const after = await client.account(game.address);
          check(sc, `game ${g} leftover withdrawn to its process`, after?.balance === 0, { before: acct, after });
          continue;
        }
        const w = await hsend(fair, fairWithdrawTags((acct.nonce || 0) + 1));
        if (w.out?.withdrawn > 0) spent.returnedAtoms += BigInt(w.out.withdrawn);
        check(sc, 'game 0 leftover withdrawn (Fair.Withdraw)', Number(w.out?.withdrawn) === acct.balance, { account: acct, reply: w.out });
      }
    });

    // ---------------------------------------------------------- F
    await scenario('F', 'negatives: replay, reused id, insufficient balance, malformed', async (sc) => {
      await withdrawAll(beacon); // start from an empty beacon balance
      const settle = async (want, ms = 30_000) => {
        const end = Date.now() + ms;
        let b;
        while (Date.now() < end) { b = await tokenBalance(); if (b === want) return b; await sleep(1000); }
        return b;
      };
      // F1: a signed pay-and-request Transfer, posted twice.
      for (let i = 0; i < N && !sc.issue; i++) {
        await run(sc, `F-replay-transfer${i}`, async () => {
          const before = await tokenBalance();
          const id = rid('Ft', i);
          const t0 = Date.now();
          const first = await wsend(token, payAndRequestTags(beacon, ahAtoms, id));
          if (tokenRefusal(first.out)) throw new Error(`token refused: ${tokenRefusal(first.out)}`);
          let second;
          try { second = await wsend(token, payAndRequestTags(beacon, ahAtoms, id), { signed: first.bytes }); }
          catch (e) { second = { status: e.status, error: e.message }; }
          const after = await settle(before - ahAtoms, 10_000);
          if (after !== before - ahAtoms) throw new ProtocolIssue(`replayed Transfer: balance moved ${(Number(before - after) / UNIT)} RNG, not ${ahPrice} (replay: ${JSON.stringify(second).slice(0, 200)})`);
          if (!second.error) throw new ProtocolIssue(`replayed Transfer was scheduled again (slot ${second.slot}) though nothing moved`);
          const served = await ahServed(me, id, await ahSeen(me, id, t0));
          return { replay: second.status, round: served.round };
        });
      }
      // F2/F3: a signed Request-Random posted twice, then the same id in a new message.
      const dep = await hsend(token, { Action: 'Transfer', Recipient: beacon, Quantity: rng(N * ahPrice), 'X-For': me });
      check(sc, 'F deposit accepted', !tokenRefusal(dep.out), dep.out);
      let expect = N * ahPrice;
      for (let i = 0; i < N && !sc.issue; i++) {
        await run(sc, `F-replay-request${i}`, async () => {
          const id = rid('Fr', i);
          const first = await wsend(beacon, { Action: 'Request-Random', 'Request-Id': id });
          if (first.out?.error) throw new Error(`beacon refused: ${first.out.error}`);
          expect -= ahPrice;
          if (Number(first.out.balance) !== expect) throw new ProtocolIssue(`balance ${first.out.balance} after request ${i}, expected ${expect}`);
          let second;
          try { second = await wsend(beacon, {}, { signed: first.bytes, charge: false }); } catch (e) { second = { status: e.status, error: e.message }; }
          if (!second.error) throw new ProtocolIssue(`replayed Request-Random scheduled again: ${JSON.stringify(second.out)}`);
          const again = await hsend(beacon, { Action: 'Request-Random', 'Request-Id': id });
          if (again.out?.duplicate !== true) throw new ProtocolIssue(`reused Request-Id answered ${JSON.stringify(again.out)}`);
          return { round: first.out.round, balance: first.out.balance, replay: second.status, reused: again.out };
        });
      }
      const short = await hsend(beacon, { Action: 'Request-Random', 'Request-Id': rid('Fx', 0) });
      check(sc, 'insufficient balance refused', short.out?.error === 'Insufficient-Balance', short.out);
      const empty = await hsend(beacon, { Action: 'Withdraw' });
      check(sc, 'nothing was charged past the deposit (Withdraw finds 0)', empty.out?.error === 'Insufficient-Balance', empty.out);
      // F5: malformed.
      const refusals = [
        ['no Request-Id', beacon, { Action: 'Request-Random' }, 'Missing-Request-Id'],
        ['129-char Request-Id', beacon, { Action: 'Request-Random', 'Request-Id': 'x'.repeat(129) }, 'Missing-Request-Id'],
        ['unknown Tier', beacon, { Action: 'Request-Random', 'Request-Id': rid('Fm', 1), Tier: 'bogus' }, 'Tier-Unavailable'],
        ['Withdraw Quantity=abc', beacon, { Action: 'Withdraw', Quantity: 'abc' }, 'Bad-Quantity'],
        ['fast: unknown Tier', fast, { Action: 'Request-Random', 'Request-Id': rid('Fm', 2), Tier: 'bogus' }, 'Tier-Unavailable'],
        ['fast: no balance', fast, { Action: 'Request-Random', 'Request-Id': rid('Fm', 3) }, 'Insufficient-Balance'],
        ['token: negative Quantity', token, { Action: 'Transfer', Recipient: beacon, Quantity: '-5' }, null],
        ['fair: Fair.Withdraw without nonce', fair, { Action: 'Fair.Withdraw' }, 'Bad-Nonce'],
      ];
      for (const [label, pid, tags, code] of refusals) {
        await run(sc, `F-malformed ${label}`, async () => {
          const { out } = await hsend(pid, tags);
          if (!out?.error || (code && out.error !== code)) throw new Error(`answered ${JSON.stringify(out)}, expected ${code || 'a refusal'}`);
          return out;
        });
      }
      await run(sc, 'F-malformed dust pay-and-request (0.5 RNG)', async () => {
        const before = await tokenBalance();
        const { out } = await hsend(token, { ...payAndRequestTags(beacon, UNIT / 2, rid('Fd', 0)) });
        if (tokenRefusal(out)) throw new Error(`token refused: ${tokenRefusal(out)}`);
        const after = await settle(before, 30_000);
        spent.returnedAtoms += BigInt(UNIT / 2);
        if (after !== before) throw new ProtocolIssue(`dust not refunded: balance ${after} vs ${before}`);
        return { refunded: true };
      });
      await run(sc, 'F-malformed fair commit without Fair.Open', async () => {
        const client = new FairClient({ fair, node, store: memoryStore() });
        try { await client.commit(me, `smoke-${runTag}-unopened`, { retries: 0 }); } catch (e) {
          if (e instanceof FairError && e.code === 'Not-Opened') return { code: e.code };
          throw e;
        }
        throw new Error('an unopened session took a commit');
      });
      await run(sc, 'F-malformed fair reveal of an unknown session', async () => {
        const { out } = await hsend(fair, fairRevealTags(me, `smoke-${runTag}-nosuch`, '0'.repeat(64), me));
        if (out?.error !== 'No-Session') throw new Error(`answered ${JSON.stringify(out)}`);
        return out;
      });
    });

    // ---------------------------------------------------------- G
    await scenario('G', `load: ${LOAD} concurrent pay-and-requests`, async (sc) => {
      const before = await key(beacon, 'beaconinfo');
      const t0 = Date.now();
      await pool(LOAD, LOAD, (i) => run(sc, `G${i}`, async () => {
        const id = rid('G', i);
        const s0 = Date.now();
        const { out } = await hsend(token, payAndRequestTags(beacon, ahAtoms, id));
        if (tokenRefusal(out)) throw new Error(`token refused: ${tokenRefusal(out)}`);
        return ahServed(me, id, await ahSeen(me, id, s0));
      }), () => !!sc.issue);
      const after = await key(beacon, 'beaconinfo');
      const burst = (after.round - before.round) / ((after.at - before.at) / 1000);
      check(sc, `all ${LOAD} served`, sc.runs.filter((r) => r.ok).length === LOAD, { served: sc.runs.filter((r) => r.ok).length, wallMs: Date.now() - t0 });
      check(sc, 'rounds/s during the burst >= 1.8', burst >= 1.8, { rate: Number(burst.toFixed(3)), rounds: after.round - before.round, ms: after.at - before.at });
      const vb = validatorView(before), va = validatorView(after);
      const moved = Object.keys({ ...vb, ...va }).filter((a) => JSON.stringify(vb[a]) !== JSON.stringify(va[a]) || va[a]?.faults || va[a]?.strikes || va[a]?.suspended);
      check(sc, 'no validator faults, strikes or suspensions', moved.length === 0, { before: vb, after: va });
      check(sc, 'beacon health ok', after.health?.status === 'ok', after.health);
      const r = await liveRate();
      check(sc, `ON_PACE (5-min average in ${ON_PACE.join('-')} rounds/s)`, r.rate >= ON_PACE[0] && r.rate <= ON_PACE[1],
        { rate: r.rate === null ? null : Number(r.rate.toFixed(3)), windowMs: r.windowMs, p50LatencyMs: r.p50LatencyMs });
    });

    // ---------------------------------------------------------- H
    await scenario('H', `fast-tier load: ${FAST_LOAD} concurrent pay-and-requests`, async (sc) => {
      const before = await key(fast, 'beaconinfo');
      await pool(FAST_LOAD, FAST_LOAD, (i) => run(sc, `H${i}`, async () => {
        const id = rid('H', i);
        const { out } = await hsend(token, payAndRequestTags(fast, fastAtoms, id));
        if (tokenRefusal(out)) throw new Error(`token refused: ${tokenRefusal(out)}`);
        return fastServed(me, id, await fastSeen(me, id), 180_000);
      }), () => !!sc.issue);
      const after = await key(fast, 'beaconinfo');
      const ok = sc.runs.filter((r) => r.ok);
      check(sc, `all ${FAST_LOAD} served`, ok.length === FAST_LOAD, { served: ok.length,
        rounds: [...new Set(ok.map((r) => r.detail.round))].length, fromRound: before?.round, toRound: after?.round });
      check(sc, 'fast tier left with nothing pending', Number(after?.pendingCount) === 0, { pendingCount: after?.pendingCount, lockedRound: after?.lockedRound });
    });
  } catch (e) {
    report.aborted = e.message;
    log(`ABORTED: ${e.message}`);
  } finally {
    // Leftovers back (a refused request leaves its credit in the balance).
    for (const pid of [beacon, fast]) {
      try { const w = await withdrawAll(pid); if (w?.withdrawn) log(`cleanup: withdrew ${w.withdrawn} RNG from ${pid.slice(0, 8)}`); }
      catch (e) { log(`cleanup withdraw ${pid.slice(0, 8)}: ${e.message}`); }
    }
    await hb.pendingPushes();
    await sleep(3000);
    const endBalance = await tokenBalance();
    report.spend = { capRng: CAP, grossSentRng: Number(spent.grossAtoms) / UNIT, transfers: spent.transfers,
      returnedRng: Number(spent.returnedAtoms) / UNIT,
      netMeasuredRng: startBalance !== null && endBalance !== null ? Number(startBalance - endBalance) / UNIT : null,
      startBalanceAtoms: String(startBalance), endBalanceAtoms: String(endBalance) };
    report.finishedAt = new Date().toISOString();
    save();
  }

  // ------------------------------------------------------------ summary
  const f = (ms) => (ms === null || ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`);
  console.log('\nscenario  pass/total  p50     p95     max     note');
  for (const s of report.scenarios) {
    const note = s.issue ? `PROTOCOL ISSUE: ${s.issue}` : s.error ? `stopped: ${s.error}` : '';
    console.log(`${s.name.padEnd(9)} ${`${s.pass}/${s.total}`.padEnd(11)} ${f(s.p50).padEnd(7)} ${f(s.p95).padEnd(7)} ${f(s.max).padEnd(7)} ${note}`);
    for (const r of [...s.runs, ...s.checks].filter((x) => !x.ok)) console.log(`          FAIL ${r.label}: ${r.error ?? JSON.stringify(r.detail)}`);
  }
  console.log(`spend: ${report.spend.grossSentRng} RNG sent in ${report.spend.transfers} transfers, ${report.spend.returnedRng} returned,`
    + ` net measured ${report.spend.netMeasuredRng} RNG (cap ${CAP})${report.aborted ? `; ABORTED: ${report.aborted}` : ''}`);
  console.log(`report: ${path.relative(ROOT, reportFile)}`);
  const failed = report.aborted || report.scenarios.some((s) => s.pass !== s.total || s.error);
  if (failed) process.exitCode = 1;
  return report;
}


// ---------------------------------------------------------------------------
// Governance and bond tests: a PLAN, NOT RUN (deploy/smoke.md). The scenarios
// above never send Gov.*, DAO, Exit or bond messages, and guard() refuses them.
// These need a separate test beacon, fast tier, fair process and DAO spawned
// for the purpose (their own state file, e.g. RNG_STATE=deploy/v3-govtest.json)
// and dedicated test validator keys; they must never run against the live DAO
// or beacon. Implementing one means: a runner that refuses unless every target
// pid differs from deploy/v3-mainnet.json's, and a guard that allows only them.
// ---------------------------------------------------------------------------
export const GOVERNANCE_PLAN = [
  { id: 'GOV-1', title: 'DAO harmless action', steps: ['stake on the test DAO', 'Propose Gov.Pause on the test beacon',
    'Vote Yes', 'wait out Voting-Period', 'finalize: the DAO executes, the beacon applies on receipt', 'read gov/paused; Propose Gov.Resume the same way'] },
  { id: 'GOV-2', title: 'DAO money action with Effective-At', steps: ['Propose Gov.Treasury-Spend with Effective-At = vote end + 24 h + margin',
    'refused without Effective-At or with one too early (proposalErrors and the contract)', 'after the vote: govPending lists it, hatch open',
    'Gov.Apply before due: refused; after due: applied once; a second Gov.Apply refused'] },
  { id: 'GOV-3', title: 'exit hatch', steps: ['while GOV-2 is pending: a test validator sends Exit-Now; bond back, owed rounds settle',
    'a payer Withdraws its balance while the action is pending', 'fast tier: a test committee member Exit-Now with its accrued fees'] },
  { id: 'GOV-4', title: 'bond, rejoin, slash cooldown', steps: ['a dedicated test validator bonds (X-Bond) to the full stake; below stake refused',
    'Ready, commits and reveals', 'misses a reveal: cracked, slashed, crackBounty paid; rejoin backoff rejoinBaseMs doubling to rejoinCapMs',
    'Exit: bond back after its rounds settle; re-bond refused while Exit-Settling'] },
  { id: 'GOV-5', title: 'Remove-Validator', steps: ['DAO proposal Gov.Remove-Validator (money: Effective-At)', 'after Gov.Apply: validator gone, bond refunded, rounds still finalize'] },
  { id: 'GOV-6', title: 'treasury cap', steps: ['Gov.Treasury-Spend above treasuryWindow.remaining: refused', 'spends within the window add to used; the window drops after windowMs'] },
];

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
