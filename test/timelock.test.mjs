// node --test test/timelock.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as tl from '../provider/timelock.mjs';

const T = 4096; // small for tests; the protocol default is 2^27
const beacon = 'B'.repeat(43);

test('trapdoor answer equals sequential squaring, and both verify', () => {
  const m = tl.newModulus(1024);
  const seed = tl.seedFor(beacon, 7, 'V'.repeat(43));
  const y = tl.solveWithTrapdoor(m, seed, T);
  const cracked = tl.crack(m.N, seed, T);
  assert.equal(cracked.y, y);
  assert.ok(tl.verifyReveal(m.N, seed, T, y, m.p));
  assert.ok(tl.verifyReveal(m.N, seed, T, y, m.q));
  assert.ok(tl.verifyCrack(m.N, seed, T, cracked.y, cracked.proof));
});

test('wrong answers, factors, seeds and proofs are refused', () => {
  const m = tl.newModulus(1024);
  const seed = tl.seedFor(beacon, 1, 'V'.repeat(43));
  const y = tl.solveWithTrapdoor(m, seed, T);
  const { proof } = tl.crack(m.N, seed, T);
  const bump = (h) => (BigInt('0x' + h) + 1n).toString(16);
  assert.equal(tl.verifyReveal(m.N, seed, T, bump(y), m.p), false);
  assert.equal(tl.verifyReveal(m.N, seed, T, y, bump(m.p)), false);
  assert.equal(tl.verifyReveal(m.N, seed, T, y, '1'), false);
  assert.equal(tl.verifyReveal(m.N, seed, T, y, m.N), false);
  assert.equal(tl.verifyReveal(m.N, tl.seedFor(beacon, 2, 'V'.repeat(43)), T, y, m.p), false);
  assert.equal(tl.verifyReveal(m.N, seed, T + 1, y, m.p), false);
  assert.equal(tl.verifyCrack(m.N, seed, T, y, bump(proof)), false);
  assert.equal(tl.verifyCrack(m.N, seed, T, bump(y), proof), false);
  assert.equal(tl.verifyCrack(m.N, seed, T, 'zz', proof), false);
});

test('x is a fixed quadratic residue of the seed', () => {
  const m = tl.newModulus(1024);
  const a = tl.deriveX(m.N, 's|1|v'), b = tl.deriveX(m.N, 's|1|v'), c = tl.deriveX(m.N, 's|2|v');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a > 1n && a < BigInt('0x' + m.N));
});

test('challenge prime is a 128-bit prime', () => {
  const l = tl.challengePrime('ab', 'cd', 'ef', 10);
  assert.equal(l.toString(2).length, 128);
  assert.ok(tl.isProbablePrime(l));
  assert.equal(tl.isProbablePrime(561n), false); // Carmichael
});

test('round value orders outputs by validator address', () => {
  const v1 = tl.roundValue(beacon, 3, { b: '2', a: '1' });
  const v2 = tl.roundValue(beacon, 3, { a: '1', b: '2' });
  assert.equal(v1, v2);
});
