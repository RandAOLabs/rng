// History lookups (validator/history.mjs) against a mocked slot store: state
// is cumulative, so a key read at slot n holds the value last written at or
// before n, as compute&slot=n/<key> does on HyperBEAM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findRound, firstSlot, indexLookup, httpReader, NotRetainedError } from '../history.mjs';
import * as browser from '../../lib/js/history.ts';

function slotStore() {
  const writes = new Map(); // key -> [[slot, value], ...] ascending
  let at = 0;
  const reads = { n: 0 };
  return {
    reads,
    write(slot, key, value) {
      at = Math.max(at, slot);
      if (!writes.has(key)) writes.set(key, []);
      writes.get(key).push([slot, value]);
    },
    read: async (slot, key) => {
      reads.n++;
      if (key === 'at-slot' && slot == null) return at;
      const list = writes.get(key) ?? [];
      const limit = slot ?? Infinity;
      let value = null;
      for (const [s, v] of list) if (s <= limit) value = v;
      return value;
    },
  };
}

// A fast-tier beacon: 600 rounds over 3000 slots, the index keeps the last 16,
// round 100 abandoned with its number skipped.
function fastBeacon() {
  const st = slotStore();
  const index = [];
  let round = 0;
  for (let slot = 1; slot <= 3000; slot++) {
    if (slot % 5 !== 0) continue;
    round++;
    if (round === 100) {
      st.write(slot, 'beaconabandoned', [{ round, skipped: true, slot, refunded: [{ requestId: 'x' }] }]);
      index.push([round, slot, 'abandoned']);
    } else {
      st.write(slot, 'beaconround', { round, value: `v${round}`, slot });
      index.push([round, slot]);
    }
    st.write(slot, 'beaconinfo', { round });
    while (index.length > 16) index.shift();
    st.write(slot, 'beaconhistory', { keep: 16, rounds: index.map((e) => [...e]) });
  }
  return st;
}

test('firstSlot finds the first slot where a monotone test holds', async () => {
  assert.equal(await firstSlot(1, 1000, async (s) => s >= 377), 377);
  assert.equal(await firstSlot(1, 1000, async () => true), 1);
  assert.equal(await firstSlot(1, 1000, async () => false), null);
});

test('a recent round is found through the index in a few reads', async () => {
  const st = fastBeacon();
  const found = await findRound(st.read, { round: 595, indexKey: 'beaconhistory', keys: () => ['beaconround', 'beaconabandoned'] });
  assert.equal(found.slot, 2975);
  assert.equal(found.record.value, 'v595');
  assert.ok(st.reads.n <= 3, `reads: ${st.reads.n}`);
  assert.deepEqual(await indexLookup(st.read, 'beaconhistory', 1), null, 'pruned from the index');
});

test('an old round is found by binary search over slots', async () => {
  const st = fastBeacon();
  const found = await findRound(st.read, { round: 7, indexKey: 'beaconhistory', keys: () => ['beaconround', 'beaconabandoned'] });
  assert.equal(found.slot, 35);
  assert.equal(found.record.value, 'v7');
  assert.equal(found.abandoned, false);
  assert.ok(st.reads.n < 40, `log2(3000) reads, got ${st.reads.n}`);
});

test('an abandoned round is found with its refunds', async () => {
  const st = fastBeacon();
  const found = await findRound(st.read, { round: 100, keys: () => ['beaconround', 'beaconabandoned'] });
  assert.equal(found.slot, 500);
  assert.equal(found.abandoned, true);
  assert.equal(found.record.refunded[0].requestId, 'x');
});

test('a round that never happened is null', async () => {
  const st = fastBeacon();
  assert.equal(await findRound(st.read, { round: 601, indexKey: 'beaconhistory', keys: () => ['beaconround'] }), null);
});

test('Any-Honest: a late (cracked) round is found by scanning past the binary search', async () => {
  const st = slotStore();
  // Rounds 1..40 finalize in order, except round 20 (cracked) finalizes after 23.
  let slot = 0;
  const order = [];
  for (let r = 1; r <= 40; r++) if (r !== 20) { order.push(r); if (r === 23) order.push(20); }
  let max = 0;
  for (const r of order) {
    slot += 3;
    max = Math.max(max, r);
    st.write(slot, `beaconround-${r % 8}`, { round: r, value: `v${r}` });
    st.write(slot, 'beaconinfo', { round: max });
  }
  const keys = (r) => [`beaconround-${r % 8}`, 'beaconabandoned'];
  assert.equal(await findRound(st.read, { round: 20, keys }), null, 'the binary search alone lands before it');
  const found = await findRound(st.read, { round: 20, keys, scan: 16 });
  assert.equal(found.record.value, 'v20');
  assert.equal(found.slot, 3 * 23);
});

// The node keeps only recent computed slots: an older one answers 410.
function retainingFetch(st, oldest) {
  return async (url) => {
    const m = url.match(/~process@1\.0\/(now|compute&slot=(\d+))\/(.+)$/);
    const slot = m[2] === undefined ? null : Number(m[2]);
    if (slot !== null && slot < oldest) return new Response('gone', { status: 410 });
    const v = await st.read(slot, m[3]);
    return v === null ? new Response('', { status: 404 }) : new Response(JSON.stringify(v), { status: 200 });
  };
}

for (const [name, lib] of [['validator/history.mjs', { findRound, httpReader, NotRetainedError }], ['lib/js/history.ts', browser]]) {
  test(`${name}: a 410 slot is "not retained by this node", a retained round is still found`, async () => {
    const st = fastBeacon();
    const read = lib.httpReader('http://hb.test', 'P'.repeat(43), retainingFetch(st, 2500));
    await assert.rejects(read(10, 'beaconinfo'), lib.NotRetainedError);
    const keys = () => ['beaconround', 'beaconabandoned'];
    // Round 520 (slot 2600) is past the index but retained: the search steps over the 410s.
    const found = await lib.findRound(read, { round: 520, indexKey: 'beaconhistory', keys });
    assert.equal(found.slot, 2600);
    await assert.rejects(lib.findRound(read, { round: 7, indexKey: 'beaconhistory', keys }),
      (e) => e instanceof lib.NotRetainedError && /round 7 is not retained by this node/.test(e.message));
    assert.equal(await lib.findRound(read, { round: 601, indexKey: 'beaconhistory', keys }), null, 'never happened: null');
  });
}
