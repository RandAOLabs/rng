// Genesis allocations for a REPLACEMENT RNG token, read from the live old one.
//
//   node deploy/migrate-allocations.mjs [--mode repoint|newbook] [--out <file>]
//
// Every atom of the old supply gets an owner under the new token, or the
// script refuses. Read-only: GETs against the rng node (old token, old beacon)
// and the paralith node (the order-book vault and its RNG pair).
//
//   old token holder        new genesis row
//   deployer                deployer (its own balance)
//   old beacon              decomposed from its timelockstate:
//     reserve, treasury,      -> deployer, re-funded by fund-reserve /
//     bonds, purses (fair)       fund-treasury / bond-for / fund-fair
//     validator accrued       -> each validator wallet, liquid
//     residual                -> deployer (reported)
//   vault                   pending RNG payouts (vaultinfo Payouts.rng, the
//                           refused Transfers in the old token's schedule)
//                           -> each recipient; the rest (= vaultsupply backing):
//     --mode repoint          -> the vault (it keeps its book; Admin re-point)
//     --mode newbook          -> each pair account's free RNG to that wallet,
//                                the burned LP base to the deployer (reseed)
//   anyone else             as is
//
// Run it AFTER the old beacon is paused (accrued stops moving) and the old
// rng_pusd book is closed (the vault's backing stops moving).
import fs from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const RNG_NODE = arg('--rng-node', 'https://rng-hb.tylerw.ai');
const PARALITH_NODE = arg('--paralith-node', 'https://hyperbeam.paralithmarkets.com');
const TOKEN = arg('--token', 'Z0yL_rU_xg8EnlicONlqZZiQiINqod-Yct5-a6OCcso');
const BEACON = arg('--beacon', 'TvgStOyfJZJvi49QkT5AaldQTqzH3OgS27uhPwWm_lY');
const VAULT = arg('--vault', 'ibtRrKfbuT0MKPcmSM3VNnM5GJbTiPqYTZagrRwFTB0');
const PAIR = arg('--pair', 'd3ew0SRotzVB6QhQKjQMgXX9DCPJcBv4soYLoGputxc');
const DEPLOYER = arg('--deployer', 'DA9qhP25ZPz6MHIhO-7aNHDN3LsTAL7yCKYIkqr13Z8');
const MODE = arg('--mode', 'repoint');
const OUT = arg('--out', '');
const SUPPLY = 1_000_000_000_000_000n;
const UNIT = 1_000_000n;
if (!['repoint', 'newbook'].includes(MODE)) throw new Error('--mode repoint|newbook');

const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
async function now(node, pid) {
  const r = await fetch(`${node}/${pid}~process@1.0/now`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${pid} /now: HTTP ${r.status}`);
  return r.json();
}
async function schedule(node, pid, to) {
  const out = [];
  for (let from = 0; from <= to; from += 30) {
    const r = await fetch(`${node}/~scheduler@1.0/schedule?target=${pid}&from=${from}&to=${Math.min(from + 29, to)}`,
      { headers: { accept: 'application/aos-2' } });
    if (!r.ok) throw new Error(`${pid} schedule ${from}: HTTP ${r.status}`);
    for (const e of (await r.json()).edges) {
      const a = Object.fromEntries(e.node.assignment.Tags.map((t) => [t.name, t.value]));
      const m = Object.fromEntries((e.node.message?.Tags || []).map((t) => [t.name.toLowerCase(), t.value]));
      out.push({ slot: Number(a.slot), admit: a['admit-process'] || '', ...m });
    }
  }
  return out;
}

const rows = new Map(); // address -> { atoms, why[] }
const give = (address, atoms, why) => {
  if (atoms <= 0n) return;
  const row = rows.get(address) || { atoms: 0n, why: [] };
  row.atoms += atoms;
  row.why.push(`${why}: ${atoms}`);
  rows.set(address, row);
};

const token = await now(RNG_NODE, TOKEN);
// A folded token publishes every balance in `balances-<n>` (its `balances` is
// only the last checkpoint); an older one, in `balances`.
const buckets = Object.keys(token).filter((k) => /^balances-\d+$/.test(k));
const held = buckets.length ? Object.assign({}, ...buckets.map((k) => json(token[k]))) : json(token.balances);
const balances = Object.fromEntries(Object.entries(held).map(([a, v]) => [a, BigInt(v)]));
const total = Object.values(balances).reduce((s, v) => s + v, 0n);
if (BigInt(token.totalsupply) !== SUPPLY || total !== SUPPLY) {
  throw new Error(`old token: totalsupply ${token.totalsupply}, balances sum ${total}, want ${SUPPLY}`);
}

// The beacon: every atom it holds belongs to exactly one bucket of its state.
const beaconNow = await now(RNG_NODE, BEACON);
const st = json(beaconNow.timelockstate);
if (st.token !== TOKEN) throw new Error(`beacon token ${st.token} is not ${TOKEN}`);
for (const k of ['exitHolds', 'strays', 'accrued', 'pending']) {
  if ((Array.isArray(st[k]) ? st[k] : Object.keys(st[k] || {})).length) throw new Error(`beacon ${k} is not empty: settle it first`);
}
// `timelockstate` is a checkpoint (every CHECKPOINT_EVERY messages on
// lua-patch), so it can trail the live state by a few rounds; `beaconinfo` is
// published every message. Read the moving buckets from it once the beacon is
// paused, so the drift since the checkpoint lands with its owners, not in the
// residual.
const binfo = json(beaconNow.beaconinfo);
const live = binfo && binfo.paused === true && Array.isArray(binfo.validators);
if (!live && !st.paused) console.error('WARNING: the old beacon is not paused; accrued is still moving');
const reserve = BigInt(live ? binfo.foundationReserveAtoms : st.foundationReserveAtoms);
const treasury = BigInt(live ? binfo.treasuryAtoms : st.treasuryAtoms);
const bonds = live
  ? Object.fromEntries(binfo.validators.filter((v) => Number(v.bond) > 0).map((v) => [v.address, BigInt(v.bond) * UNIT]))
  : Object.fromEntries(Object.entries(st.bonds || {}).map(([a, v]) => [a, BigInt(v) * UNIT]));
const accrued = live
  ? Object.fromEntries(binfo.validators.filter((v) => BigInt(v.earnedAtoms || 0) > 0n).map((v) => [v.address, BigInt(v.earnedAtoms)]))
  : Object.fromEntries(Object.entries(st.accruedAtoms || {}).map(([a, v]) => [a, BigInt(v)]));
const purses = Object.fromEntries(Object.entries(st.balances || {}).map(([a, v]) => [a, BigInt(v) * UNIT]));
const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0n);
const beaconHeld = balances[BEACON] || 0n;
const residual = beaconHeld - reserve - treasury - sum(bonds) - sum(accrued) - sum(purses) - BigInt(st.protocolAccrued || 0);
if (residual < 0n) throw new Error(`beacon owes more than it holds by ${-residual} atoms`);
const reserveRng = reserve / UNIT;
give(DEPLOYER, reserveRng * UNIT, 'old beacon reserve, re-funded by fund-reserve');
give(DEPLOYER, reserve - reserveRng * UNIT, 'old beacon reserve, the fraction below one RNG');
give(DEPLOYER, treasury, 'old beacon treasury, re-funded by fund-treasury');
for (const [a, v] of Object.entries(bonds)) give(DEPLOYER, v, `bond of ${a}, re-bonded by bond-for`);
for (const [a, v] of Object.entries(purses)) give(DEPLOYER, v, `beacon balance of ${a}, re-funded (fund-fair)`);
for (const [a, v] of Object.entries(accrued)) give(a, v, 'validator earnings accrued in the old beacon');
give(DEPLOYER, residual + BigInt(st.protocolAccrued || 0), 'old beacon residual (held, in no bucket)');

// The vault: what it already paid (refused by the old token) goes to the
// payee; the rest is the vault's backing, which its book still owes.
const vaultNow = await now(PARALITH_NODE, VAULT);
const info = json(vaultNow.vaultinfo);
if (info.Assets?.rng?.process !== TOKEN) throw new Error('the vault does not list the old token as rng');
const pending = (info.Payouts?.rng?.pending || []).map(String);
const backing = BigInt(json(vaultNow.vaultsupply).rng.backing);
const sched = await schedule(RNG_NODE, TOKEN, Number(token['at-slot']));
const bySeq = new Map();
for (const m of sched) {
  if (m.admit !== VAULT || m.action !== 'Transfer') continue;
  const seq = m['x-transfer-sequence'];
  const seen = bySeq.get(seq);
  const row = { recipient: m.recipient, atoms: BigInt(m.quantity) };
  if (seen && (seen.recipient !== row.recipient || seen.atoms !== row.atoms)) throw new Error(`sequence ${seq} sent two ways`);
  bySeq.set(seq, row);
}
const payouts = pending.map((seq) => {
  const p = bySeq.get(seq);
  if (!p) throw new Error(`pending payout ${seq} never reached the old token`);
  return { sequence: seq, ...p };
});
const paid = payouts.reduce((s, p) => s + p.atoms, 0n);
const vaultHeld = balances[VAULT] || 0n;
if (vaultHeld - paid !== backing) throw new Error(`vault holds ${vaultHeld}, pending ${paid}, backing ${backing}: they disagree`);
for (const p of payouts) give(p.recipient, p.atoms, `vault payout ${p.sequence} the old token refused`);
let bookRows = [];
if (MODE === 'repoint') {
  give(VAULT, backing, 'vault rng backing (its book carries over)');
} else {
  const pair = await now(PARALITH_NODE, PAIR);
  let free = 0n;
  for (const [k, v] of Object.entries(pair)) {
    if (!k.startsWith('balance-')) continue;
    const acct = json(v);
    const n = BigInt(acct.free?.rng || 0);
    if (n > 0n) { give(acct.account, n, 'free RNG in the old rng_pusd pair'); free += n; bookRows.push([acct.account, n]); }
  }
  give(DEPLOYER, backing - free, 'old rng_pusd LP (burned seed), to reseed the new book');
}

// Everyone else, as is.
for (const [a, v] of Object.entries(balances)) if (a !== BEACON && a !== VAULT) give(a, v, 'old balance');

const allocations = [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([address, r]) => ({ role: address === DEPLOYER ? 'deployer' : address === VAULT ? 'vault' : 'holder', address, atoms: String(r.atoms), why: r.why }));
const out = allocations.reduce((s, r) => s + BigInt(r.atoms), 0n);
if (out !== SUPPLY) throw new Error(`allocations sum to ${out}, not ${SUPPLY}`);
const doc = {
  ticker: 'RNG',
  note: `Replacement RNG genesis (${MODE}) from the old token ${TOKEN} at slot ${token['at-slot']}, `
    + `beacon ${BEACON} at slot ${beaconNow['at-slot']}, vault ${VAULT} at slot ${vaultNow['at-slot']}. `
    + 'Every row says why; the distribution is what the runbook re-funds from the deployer.',
  allocations,
  distribution: {
    reserveRng: Number(reserveRng),
    treasuryRng: Number(treasury / UNIT),
    validatorRng: 0,
    validatorBonds: Object.fromEntries(Object.entries(bonds).map(([a, v]) => [a, Number(v / UNIT)])),
    fairFloatRng: Number(sum(purses) / UNIT),
  },
  evidence: {
    oldToken: TOKEN, oldTokenSlot: Number(token['at-slot']), beaconPaused: !!st.paused,
    beaconResidualAtoms: String(residual), vaultBacking: String(backing),
    pendingPayouts: payouts.map((p) => ({ ...p, atoms: String(p.atoms) })),
    newbookFreeRng: bookRows.map(([a, n]) => ({ account: a, atoms: String(n) })),
  },
};
if (doc.distribution.treasuryRng * Number(UNIT) !== Number(treasury)) throw new Error('treasury is not whole RNG');
const text = JSON.stringify(doc, null, 1) + '\n';
if (OUT) fs.writeFileSync(OUT, text); else process.stdout.write(text);
console.error(`ok: ${allocations.length} holders, ${out} atoms; pending payouts ${payouts.length} = ${paid} atoms; `
  + `reserve ${reserveRng} RNG, treasury ${treasury / UNIT} RNG, bonds ${sum(bonds) / UNIT} RNG, `
  + `accrued ${sum(accrued)} atoms, residual ${residual} atoms`);
