// Time-lock validator (SPEC.md §4): commits a fresh modulus when a round
// opens, reveals with its trapdoor when commits close, cracks reveals that
// are still missing after the deadline. No shared secret with anyone.
//
//   node provider/validator.mjs init <config>   create the validator wallet, print its address
//   node provider/validator.mjs run  <config>
//
// Config: { beacon, hbNode, dataDir, listen? }. Uses RNG_CRACKER (native GMP)
// for cracks when set, else JavaScript.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readState, jwkToAddress } from '../vendor/hbclient.mjs';
import { message } from './hb.mjs';
import * as tl from './timelock.mjs';

const run = promisify(execFile);
const [cmd, configPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const file = (...p) => path.join(cfg.dataDir, ...p);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (cmd === 'init') {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  if (!fs.existsSync(file('validator-wallet.json'))) {
    const jwk = crypto.generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 65537 }).privateKey.export({ format: 'jwk' });
    fs.writeFileSync(file('validator-wallet.json'), JSON.stringify(jwk), { mode: 0o600 });
  }
  console.log(JSON.stringify({ address: jwkToAddress(JSON.parse(fs.readFileSync(file('validator-wallet.json'), 'utf8'))) }));
  process.exit(0);
}

const jwk = JSON.parse(fs.readFileSync(file('validator-wallet.json'), 'utf8'));
const me = jwkToAddress(jwk);
fs.mkdirSync(file('puzzles'), { recursive: true });

async function info() {
  const r = await readState({ node: cfg.hbNode, process: cfg.beacon, path: 'now/beaconinfo' });
  if (r.status !== 200) throw new Error(`beaconinfo: HTTP ${r.status}`);
  return JSON.parse(r.value);
}
const post = (action, data) => message({ node: cfg.hbNode, jwk, process: cfg.beacon, action, data: JSON.stringify(data) });

// Moduli are made ahead of time (~40 ms each) and used once.
const pool = [];
const refill = (bits) => { while (pool.length < 4) pool.push(tl.newModulus(bits)); };

/** The trapdoor for a round is on disk before the commit is sent, so a restart can still reveal. */
const puzzleFile = (round) => file('puzzles', `${round}.json`);

async function crackNative(N, x, T) {
  const bin = process.env.RNG_CRACKER;
  const y = (await run(bin, ['y', N, x.toString(16), String(T)], { maxBuffer: 1 << 20 })).stdout.trim();
  const l = tl.challengePrime(N, x.toString(16), y, T);
  const proof = (await run(bin, ['proof', N, x.toString(16), String(T), l.toString(16)], { maxBuffer: 1 << 20 })).stdout.trim();
  return { y, proof };
}

const cracking = new Set();
async function crack(info, o, target) {
  const key = `${o.round}|${target}`;
  if (cracking.has(key)) return;
  cracking.add(key);
  const N = o.committed[target];
  const seed = tl.seedFor(info.self, o.round, target);
  const T = info.params.T;
  log(`cracking ${target.slice(0, 8)} for round ${o.round} (T=${T}, ${process.env.RNG_CRACKER ? 'native' : 'js'})`);
  const t0 = Date.now();
  try {
    const { y, proof } = process.env.RNG_CRACKER
      ? await crackNative(N, tl.deriveX(N, seed), T)
      : tl.crack(N, seed, T);
    if (!tl.verifyCrack(N, seed, T, y, proof)) throw new Error('own crack does not verify');
    await post('Crack', { round: o.round, validator: target, y, proof });
    log(`cracked ${target.slice(0, 8)} round ${o.round} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    log('crack failed:', e.message);
  } finally {
    cracking.delete(key);
  }
}

let status = { address: me };
if (cfg.listen) {
  http.createServer((_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(status)); })
    .listen(cfg.listen, '127.0.0.1');
}
log(`validator ${me} watching ${cfg.beacon}`);

// What we last sent per round. The beacon's published state is the truth;
// this only stops resending more often than every 1-3 s while it catches up.
const sent = { commit: { round: 0, at: 0 }, rejoin: { round: 0, at: 0 } };
const due = (kind, round, now, ms = 3000) => sent[kind].round !== round || now - sent[kind].at > ms;
const mark = (kind, round, now) => { sent[kind] = { round, at: now }; };
// Several rounds can be revealing at once, so reveals are tracked per round.
const revealed = new Map();
const dueReveal = (round, now) => !revealed.has(round) || now - revealed.get(round) > 3000;
for (;;) {
  try {
    const i = await info();
    const o = i.open ?? {};
    const mine = i.validators.find((v) => v.address === me);
    status = { address: me, round: i.round, open: o.round, phase: o.phase, suspended: mine?.suspended ?? null, pool: pool.length };
    refill(i.params.modulusBits);
    const committed = o.committed ?? {};
    const now = Date.now();

    // Suspended: rejoin on our own (idle at once, slashed after the cooldown)
    // while the bond still covers the next slash (SPEC.md §2.2).
    if (mine?.suspended && mine.bond >= i.params.slash && (mine.idle || i.round >= mine.suspendedAt + i.params.rejoinAfter) && due('rejoin', i.round, now)) {
      log(`${mine.idle ? 'idle' : 'suspended'} since round ${mine.suspendedAt}; rejoining with bond ${mine.bond}`);
      await post('Rejoin', {});
      mark('rejoin', i.round, now);
    }

    // Commit as soon as the cadence allows: every round with the heartbeat
    // on, else only rounds with requests waiting.
    if (mine && !mine.suspended && (o.phase === 'collecting' || o.phase === 'commit') && (o.pending > 0 || i.params.heartbeat)
        && now >= i.nextRoundAt && !committed[me] && due('commit', o.round, now, 1000)) {
      // Reuse this round's modulus on a resend: it was never revealed.
      const m = fs.existsSync(puzzleFile(o.round)) ? JSON.parse(fs.readFileSync(puzzleFile(o.round), 'utf8')) : pool.shift();
      fs.writeFileSync(puzzleFile(o.round), JSON.stringify(m), { mode: 0o600 });
      await post('Commit', { round: o.round, modulus: m.N });
      mark('commit', o.round, now);
    }

    // Rounds overlap: the open round takes commits while older ones reveal.
    const rounds = [...(i.revealing ?? []), o];
    for (const x of rounds) {
      const committedX = x.committed ?? {};
      // Reveal once commits close (or the window has passed by our clock:
      // the reveal itself makes the beacon close the commits).
      const windowOver = x.commitDeadline > 0 && now >= x.commitDeadline;
      if (committedX[me] && !(x.revealed ?? []).includes(me) && (x.phase === 'reveal' || windowOver) && dueReveal(x.round, now)) {
        const m = JSON.parse(fs.readFileSync(puzzleFile(x.round), 'utf8'));
        if (m.N !== committedX[me]) {
          log(`round ${x.round}: committed modulus is not the one on disk; cannot reveal`);
        } else {
          const y = tl.solveWithTrapdoor(m, tl.seedFor(i.self, x.round, me), i.params.T);
          await post('Reveal', { round: x.round, y, p: m.p });
          revealed.set(x.round, now);
        }
      }

      // Crack reveals still missing after the deadline. Validators take turns
      // by address order, one reveal window apart, so one cracks and the rest wait.
      if (x.phase === 'reveal' && x.revealDeadline > 0) {
        const order = (x.active ?? []).filter((a) => committedX[a]).sort();
        for (const target of Object.keys(committedX)) {
          if ((x.revealed ?? []).includes(target) || target === me) continue;
          const turns = order.filter((a) => a !== target);
          const myTurn = turns.indexOf(me);
          if (myTurn >= 0 && now >= x.revealDeadline + myTurn * i.params.revealWindowMs) crack(i, x, target);
        }
      }
    }

    // A trapdoor is only needed until its round is done.
    const oldest = Math.min(...rounds.map((x) => x.round));
    for (const f of fs.readdirSync(file('puzzles'))) {
      if (Number(f.replace('.json', '')) < oldest) fs.rmSync(file('puzzles', f));
    }
    for (const r of revealed.keys()) if (r < oldest) revealed.delete(r);
  } catch (e) {
    log('loop error:', e.message);
  }
  await sleep(150);
}
