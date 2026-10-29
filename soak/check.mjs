// Soak checker: re-verifies everything the beacon and the contracts claim,
// and writes soak/data/report.json + report.md every cycle.
//
//   node soak/check.mjs            (runs alongside soak/run.mjs)
//
// Pass (SOAK_HOURS, default 24): zero bad signatures, zero wrong results, zero lost requests,
// zero accepted duplicates or unfunded requests, no stall over 3 cadences,
// p95 request-to-result within cadence + 2 s, dice uniform (chi-square).
import fs from 'node:fs';
import path from 'node:path';
import { readState } from '../vendor/hbclient.mjs';
import * as bls from '../provider/bls.mjs';
import { stream } from '../test/reference.mjs';
import * as tl from '../provider/timelock.mjs';
import { BEACON, TIMELOCK, DATA, NODE, appendLine, env, log, read, readJson, readLines, sha256hex, sleep, writeJson } from './common.mjs';

const EVERY = env('CHECK_EVERY_S', 20) * 1000;
// Rounds run every second or so and only the last few stay in published
// state, so rounds are archived on a much shorter loop than the full check.
const ARCHIVE_EVERY = env('ARCHIVE_EVERY_S', 2) * 1000;
const HOURS = env('SOAK_HOURS', 24);
const LOST_AFTER = env('LOST_AFTER_MIN', 10) * 60_000;

const rounds = new Map(readLines('rounds.jsonl').map((r) => [r.round, r]));
const tlRounds = new Map(readLines('timelock-rounds.jsonl').map((r) => [r.round, r]));
const maxKey = (m) => { let x = 0; for (const k of m.keys()) if (k > x) x = k; return x; };
let maxRound = maxKey(rounds), maxTl = maxKey(tlRounds);
const s = readJson('check-state.json', {
  actionsRead: 0, direct: {}, expectRefusal: {}, checkedResults: {}, faces: [0, 0, 0, 0, 0, 0],
  latencies: [], problems: [], stalls: 0, lastRound: 0, lastRoundSeenAt: 0, firstCheck: Date.now(),
  directTl: {}, tl: { complete: true, expectedAccrued: 0, protocol: 0, cracks: 0, lastRound: 0, lastRoundSeenAt: Date.now() },
});
const problem = (kind, detail) => {
  const p = { t: Date.now(), kind, ...detail };
  s.problems.push(p);
  appendLine('problems.jsonl', p);
  log('PROBLEM', kind, JSON.stringify(detail));
};

async function slotReply(slot) {
  const r = await readState({ node: NODE, process: BEACON, path: `compute&slot=${slot}/results/output/data` });
  try { return JSON.parse(r.value); } catch { return { raw: r.value }; }
}

function archive(state) {
  const live = Object.keys(state.rounds ?? {}).map(Number).sort((a, b) => a - b);
  if (live.length && rounds.size && live[0] > maxRound + 1) {
    problem('archive-gap', { from: maxRound + 1, to: live[0] - 1 });
  }
  for (const n of live) {
    if (rounds.has(n)) continue;
    maxRound = Math.max(maxRound, n);
    const r = state.rounds[String(n)];
    const verified = bls.verify(state.groupKey, `${state.self}|${n}`, r.signature);
    const valueOk = sha256hex(`round|${r.signature}`) === r.value;
    const rec = { round: n, at: r.at, signers: r.signers, signature: r.signature, value: r.value, verified, valueOk };
    rounds.set(n, rec);
    appendLine('rounds.jsonl', rec);
    if (!verified || !valueOk) problem('bad-round', { round: n, verified, valueOk });
  }
}

function archiveTimelock(st) {
  const live = Object.keys(st.rounds ?? {}).map(Number).sort((a, b) => a - b);
  // Rounds can finish out of order (a cracked one finishes late), so a gap
  // only counts if none of the missing rounds is still open.
  const open = new Set(Object.keys(st.opens ?? {}).map(Number));
  const missing = [];
  for (let n = maxTl + 1; live.length && n < live[0]; n++) if (!open.has(n)) missing.push(n);
  if (missing.length && maxTl > 0) {
    problem('timelock-archive-gap', { from: missing[0], to: missing[missing.length - 1] });
    s.tl.complete = false;
  }
  // h for each T seen, checked against its proof (x = g), since a round only records its T.
  const { T: pT, h: pH, hProof } = st.params ?? {};
  s.tl.h ||= {};
  if (pT && pH && s.tl.h[pT] !== pH && s.tl.badH !== pH) {
    if (hProof && !tl.verifyCrack(tl.G_HEX, pT, pH, hProof).valid) { problem('timelock-bad-h', { T: pT }); s.tl.badH = pH; }
    else s.tl.h[pT] = pH;
  }
  // What each waiting request was charged (a record only keeps the count).
  s.tl.charged ||= {};
  for (const [k, list] of Object.entries(st.pending ?? {})) s.tl.charged[k] = list.map((p) => Number(p.charged));
  for (const n of live) {
    if (tlRounds.has(n)) continue;
    maxTl = Math.max(maxTl, n);
    const r = st.rounds[String(n)];
    const T = r.T ?? pT;
    const h = r.h ?? s.tl.h[T];
    let verified = true, cracks = 0;
    const ys = {};
    for (const [addr, out] of Object.entries(r.outputs ?? {})) {
      // Reveals: g^alpha = c and y = h^alpha; cracks: Wesolowski with x = c. Hashed as y*.
      ys[addr] = tl.checkOutput(r.commits[addr], out, T, h);
      if (out.via === 'crack') cracks++;
      if (ys[addr] === null) verified = false;
    }
    const valueOk = tl.roundValue(st.self, n, ys) === r.value;
    const outputs = Object.keys(r.outputs ?? {}).length;
    const rec = { round: n, opened: r.opened, finalizedAt: r.finalizedAt, requests: r.requests, outputs, cracks, value: r.value, verified, valueOk };
    tlRounds.set(n, rec);
    appendLine('timelock-rounds.jsonl', rec);
    // Per request: 1 to each of k = min(contributors, charged - 1) validators, 1 to the
    // protocol, the rest back. Charges not seen while waiting are taken as the full price.
    const charged = s.tl.charged[n]?.length === r.requests ? s.tl.charged[n] : Array(r.requests).fill(outputs + 1);
    for (const c of charged) {
      s.tl.expectedAccrued += Math.max(0, Math.min(outputs, c - 1));
      s.tl.protocol += Math.min(1, c);
    }
    delete s.tl.charged[n]; // rounds finish out of order, so only this one
    s.tl.cracks += cracks;
    if (!verified || !valueOk) problem('bad-timelock-round', { round: n, verified, valueOk });
  }
}

function checkTimelock(st, info) {
  const accrued = Object.values(st.accrued ?? {}).reduce((a, b) => a + Number(b), 0);
  // Rounds that finished before the checker first looked are taken as given:
  // fees are counted from that snapshot on, and slashes from the bonds then.
  if (!s.tl.base) {
    s.tl.base = { bonds: { ...(st.bonds ?? {}) } };
    s.tl.expectedAccrued = accrued;
    s.tl.protocol = Number(st.protocolAccrued);
  }
  const slashed = Object.entries(s.tl.base.bonds).reduce((a, [v, b]) => a + Number(b) - Number(st.bonds?.[v] ?? 0), 0);
  const expectedProtocol = s.tl.protocol + slashed;
  if (s.tl.complete && (accrued !== s.tl.expectedAccrued || Number(st.protocolAccrued) !== expectedProtocol)) {
    const key = `${accrued}/${s.tl.expectedAccrued}/${st.protocolAccrued}/${expectedProtocol}`;
    if (key !== s.tl.lastFeeKey) problem('timelock-fee-mismatch', { accrued, expected: s.tl.expectedAccrued, protocol: st.protocolAccrued, expectedProtocol });
    s.tl.lastFeeKey = key;
  }
  if (info.round > s.tl.lastRound) { s.tl.lastRound = info.round; s.tl.lastRoundSeenAt = Date.now(); }
  // With the heartbeat on, rounds never stop; a cracked round no longer holds up the rest.
  const tlStallMs = info.params?.heartbeat ? 60_000 : 15 * 60_000;
  if ((info.pendingCount > 0 || info.params?.heartbeat) && Date.now() - s.tl.lastRoundSeenAt > tlStallMs) {
    problem('timelock-stall', { round: info.round, phase: info.open?.phase, pending: info.pendingCount });
    s.tl.lastRoundSeenAt = Date.now();
  }
  for (const [key, d] of Object.entries(s.directTl)) {
    const bound = st.seen?.[key];
    const round = bound !== undefined ? tlRounds.get(Number(bound)) : undefined;
    if (round) {
      s.latencies.push({ t: d.t, ms: round.finalizedAt - d.t, via: 'timelock' });
      delete s.directTl[key];
    } else if (Date.now() - d.t > 30 * 60_000) {
      if (bound !== undefined) problem('timelock-direct-lost', { key, bound });
      delete s.directTl[key];
    }
  }
}

async function checkActions(state) {
  const actions = readLines('actions.jsonl');
  for (const a of actions.slice(s.actionsRead)) {
    if (a.kind === 'direct' && a.slot !== undefined) s.direct[`${a.from}|${a.requestId}`] = { t: a.t, slot: a.slot };
    if (a.kind === 'direct-timelock' && a.slot !== undefined) s.directTl[`${a.from}|${a.requestId}`] = { t: a.t };
    if (a.kind === 'direct' && a.slot !== undefined) (s.recentDirect ??= {})[`${a.from}|${a.requestId}`] = { t: a.t, slot: a.slot };
    if ((a.kind === 'duplicate' || a.kind === 'unfunded') && a.slot !== undefined) s.expectRefusal[`${a.kind}|${a.slot}`] = { t: a.t, slot: a.slot, kind: a.kind, key: `${a.from}|${a.requestId}` };
  }
  s.actionsRead = actions.length;
  for (const [key, d] of Object.entries(s.recentDirect ?? {})) if (Date.now() - d.t > 15 * 60_000) delete s.recentDirect[key];

  for (const [key, d] of Object.entries(s.direct)) {
    const bound = state.seen?.[key];
    const round = bound !== undefined ? rounds.get(Number(bound)) : undefined;
    if (round) {
      s.latencies.push({ t: d.t, ms: round.at - d.t, via: 'direct' });
      delete s.direct[key];
    } else if (bound === undefined && Date.now() - d.t > 120_000 && !d.classified) {
      // Not bound to a round: the beacon must have refused it. Find out why.
      const reply = await slotReply(d.slot);
      d.classified = reply.error ?? 'no reply';
      if (reply.error !== 'Insufficient-Balance') problem('direct-refused', { key, reply: d.classified });
      delete s.direct[key];
    } else if (Date.now() - d.t > LOST_AFTER) {
      problem('direct-lost', { key, bound });
      delete s.direct[key];
    }
  }

  for (const [key, e] of Object.entries(s.expectRefusal)) {
    if (Date.now() - e.t < 60_000) continue;
    const reply = await slotReply(e.slot);
    // A duplicate is answered without an error (and without a charge).
    const refused = e.kind === 'duplicate' ? reply.duplicate === true || reply.error === 'Duplicate-Request'
      : reply.error === 'Insufficient-Balance';
    // The copy can be scheduled before the original (they are sent concurrently):
    // then the copy is charged and the original, at the later slot, is the duplicate.
    const orig = e.kind === 'duplicate' ? s.recentDirect?.[e.key] : undefined;
    const swapped = !refused && orig && orig.slot > e.slot && (await slotReply(orig.slot)).duplicate === true;
    if (!refused && !swapped) problem(`${e.kind}-accepted`, { slot: e.slot, reply });
    delete s.expectRefusal[key];
  }
}

async function checkContracts() {
  const contracts = readJson('contracts.json', []);
  for (const { pid } of contracts) {
    let st;
    try { st = await read(pid, 'consumerstats'); } catch { continue; }
    for (const r of st.results ?? []) {
      if (s.checkedResults[r.requestId]) continue;
      const timelock = r.tier === 'timelock';
      const round = (timelock ? tlRounds : rounds).get(Number(r.round));
      if (!round) continue; // round not archived yet; next cycle
      const want = sha256hex(`${round.value}|${pid}|${r.requestId}`);
      const die = stream(`beacon|${want}`).int(1, 6);
      if (r.value !== want || r.die !== die) problem('wrong-result', { pid, requestId: r.requestId, round: r.round });
      s.faces[die - 1]++;
      s.latencies.push({ t: Date.now(), ms: r.latencyMs, via: timelock ? 'timelock' : 'contract' });
      s.checkedResults[r.requestId] = 1;
    }
    for (const [id, at] of Object.entries(st.pending ?? {})) {
      if (Date.now() - Number(at) > LOST_AFTER && !s.checkedResults[`lost|${id}`]) {
        problem('contract-lost', { pid, requestId: id });
        s.checkedResults[`lost|${id}`] = 1;
      }
    }
  }
}

function checkInvariants(state, info) {
  const accrued = Object.values(state.accrued ?? {}).reduce((a, b) => a + Number(b), 0);
  // Report each new imbalance or equivocation once, not every cycle.
  const gap = info.threshold * Number(state.protocolAccrued) - accrued;
  if (gap !== 0 && gap !== s.lastFeeGap) problem('fee-mismatch', { accrued, protocol: state.protocolAccrued, gap });
  s.lastFeeGap = gap;
  s.equivocations ||= {};
  for (const [m, n] of Object.entries(state.equivocations ?? {})) {
    if (Number(n) > (s.equivocations[m] ?? 0)) problem('equivocation', { member: m, n });
    s.equivocations[m] = Number(n);
  }
  // Liveness: requests waiting (or the heartbeat on), but no round for 3 cadences (+ 30 s slack).
  if (info.round > s.lastRound) { s.lastRound = info.round; s.lastRoundSeenAt = Date.now(); }
  if ((info.pendingCount > 0 || info.heartbeat) && Date.now() - s.lastRoundSeenAt > 3 * state.cadenceMs + 30_000) {
    s.stalls++;
    problem('stall', { round: info.round, pending: info.pendingCount, sinceMs: Date.now() - s.lastRoundSeenAt });
    s.lastRoundSeenAt = Date.now();
  }
}

const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

function report(state) {
  const sorted = (f) => s.latencies.filter(f).map((l) => l.ms).filter((x) => x >= 0).sort((a, b) => a - b);
  const ms = sorted((l) => l.via !== 'timelock');
  const tms = sorted((l) => l.via === 'timelock');
  const total = s.faces.reduce((a, b) => a + b, 0);
  const chi = total ? s.faces.reduce((a, f) => a + (f - total / 6) ** 2 / (total / 6), 0) : 0;
  const counts = {};
  for (const p of s.problems) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
  const hours = (Date.now() - s.firstCheck) / 3_600_000;
  const p95 = pct(ms, 95);
  const r = {
    updated: new Date().toISOString(), hours: +hours.toFixed(2), rounds: rounds.size,
    resultsChecked: total, latencyMs: { p50: pct(ms, 50), p95, p99: pct(ms, 99), n: ms.length },
    timelock: { rounds: tlRounds.size, cracks: s.tl.cracks, latencyMs: { p50: pct(tms, 50), p95: pct(tms, 95), p99: pct(tms, 99), n: tms.length } },
    dice: { faces: s.faces, chiSquare: +chi.toFixed(2) }, problems: counts,
    pass: {
      noBadRounds: !counts['bad-round'] && !counts['bad-timelock-round'] && !counts['timelock-bad-h'],
      timelockFeesBalance: !counts['timelock-fee-mismatch'], timelockNoStalls: !counts['timelock-stall'] && !counts['timelock-direct-lost'], noWrongResults: !counts['wrong-result'],
      noLostRequests: !counts['direct-lost'] && !counts['contract-lost'],
      refusalsHeld: !counts['duplicate-accepted'] && !counts['unfunded-accepted'],
      noStalls: !counts.stall, latencyOk: p95 === null || p95 <= state.cadenceMs + 2000,
      diceUniform: total < 600 || chi < 20.52, // p < 0.001 at 5 degrees of freedom
      fullDuration: hours >= HOURS,
    },
  };
  r.verdict = Object.values(r.pass).every(Boolean) ? 'PASS' : r.pass.fullDuration ? 'FAIL' : 'RUNNING';
  writeJson('report.json', r);
  fs.writeFileSync(path.join(DATA, 'report.md'), [
    `# Soak report (${r.verdict})`, '',
    `Updated ${r.updated}, ${r.hours} h in. ${r.rounds} rounds verified, ${r.resultsChecked} contract results checked.`, '',
    `Quick tier latency: p50 ${r.latencyMs.p50} ms, p95 ${r.latencyMs.p95} ms, p99 ${r.latencyMs.p99} ms over ${r.latencyMs.n} requests.`, '',
    `Time-lock tier: ${r.timelock.rounds} rounds verified (${r.timelock.cracks} cracked); latency p50 ${r.timelock.latencyMs.p50} ms, p95 ${r.timelock.latencyMs.p95} ms over ${r.timelock.latencyMs.n} requests.`, '',
    `Dice faces ${r.dice.faces.join(' / ')}, chi-square ${r.dice.chiSquare}.`, '',
    '| Check | Status |', '|---|---|',
    ...Object.entries(r.pass).map(([k, v]) => `| ${k} | ${v ? 'ok' : 'NOT YET / FAIL'} |`), '',
    `Problems: ${Object.keys(counts).length ? JSON.stringify(counts) : 'none'}`,
  ].join('\n'));
  return r;
}

async function archiveFor(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      archive(await read(BEACON, 'beaconstate'));
      if (TIMELOCK) archiveTimelock(await read(TIMELOCK, 'timelockstate'));
    } catch (e) {
      log('archive error:', e.message);
    }
    await sleep(ARCHIVE_EVERY);
  }
}

for (;;) {
  try {
    const [state, info, guards] = await Promise.all([read(BEACON, 'beaconstate'), read(BEACON, 'beaconinfo'), read(BEACON, 'beaconguards')]);
    state.seen = guards.seen; // published apart from the state
    archive(state);
    await checkActions(state);
    await checkContracts();
    checkInvariants(state, info);
    if (TIMELOCK) {
      const [tst, tinfo, tguards] = await Promise.all([read(TIMELOCK, 'timelockstate'), read(TIMELOCK, 'beaconinfo'), read(TIMELOCK, 'timelockguards')]);
      tst.seen = tguards.seen; // published apart from the state
      archiveTimelock(tst);
      checkTimelock(tst, tinfo);
    }
    if (s.latencies.length > 200_000) s.latencies = s.latencies.slice(-100_000);
    writeJson('check-state.json', s);
    const r = report(state);
    log(`${r.verdict}: ${r.rounds} rounds, ${r.resultsChecked} results, p95 ${r.latencyMs.p95} ms, problems ${JSON.stringify(r.problems)}`);
  } catch (e) {
    log('check error:', e.message);
  }
  await archiveFor(EVERY);
}
