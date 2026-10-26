// node --test test/bls.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as bls from '../provider/bls.mjs';

const runDkg = (n, t) => {
  const deals = {};
  for (let i = 1; i <= n; i++) deals[i] = bls.dkgDeal(n, t);
  const commitments = Object.fromEntries(Object.entries(deals).map(([i, d]) => [i, d.commitments]));
  const members = [];
  for (let j = 1; j <= n; j++) {
    const received = Object.fromEntries(Object.entries(deals).map(([i, d]) => [i, d.shares[j]]));
    members.push(bls.dkgFinish(j, n, received, commitments));
  }
  return { deals, commitments, members };
};

test('dealer keygen: any t partials give one valid signature', () => {
  const k = bls.dealerKeygen(3, 2);
  const m = 'beacon|1';
  const p = k.shares.map((s) => ({ index: s.index, signature: bls.partialSign(s, m) }));
  const s = bls.combine([p[0], p[1]]);
  assert.equal(s, bls.combine([p[1], p[2]]));
  assert.ok(bls.verify(k.groupKey, m, s));
  assert.ok(!bls.verify(k.groupKey, 'beacon|2', s));
});

test('DKG: members agree on keys and any 2 of 3 sign', () => {
  const { members } = runDkg(3, 2);
  for (const m of members) {
    assert.equal(m.groupKey, members[0].groupKey);
    assert.deepEqual(m.sharePublicKeys, members[0].sharePublicKeys);
  }
  const msg = 'beacon|7';
  const partials = members.map((m) => ({ index: m.index, signature: bls.partialSign(m, msg) }));
  partials.forEach((p, i) => assert.ok(bls.verifyPartial(members[i].publicKey, msg, p.signature)));
  const sigs = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => bls.combine([partials[a], partials[b]]));
  assert.equal(new Set(sigs).size, 1);
  assert.ok(bls.verify(members[0].groupKey, msg, sigs[0]));
});

test('DKG: a tampered share is caught', () => {
  const { deals, commitments } = runDkg(3, 2);
  const received = { 1: deals[1].shares[2], 2: deals[2].shares[2], 3: deals[3].shares[1] }; // dealer 3 sent member 1's share
  assert.equal(bls.dkgVerifyShare(2, received[3], commitments[3]), false);
  assert.throws(() => bls.dkgFinish(2, 3, received, commitments), /bad share from dealer 3/);
});
