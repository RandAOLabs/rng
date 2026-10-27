// Emits time-lock interop vectors for HyperBEAM's timelock@1.0 device from the
// reference implementation (provider/timelock.mjs), as an Erlang function body
// for dev_timelock_test_vectors:timelock_vectors/0.
//   node test/gen-timelock-vectors.mjs > vectors.erl.txt   (from the rng repo)
// Every expected `valid' is checked against the reference before it is written.
import * as tl from 'file:///C:/REPO/rng/provider/timelock.mjs';

const beacon = 'Xk3_9vQ2mZpL7aRtYw4Hn1cBfGdJs8uEoVq6iT0yK5A';
const validator = 'V'.repeat(43);
const bump = (h) => (BigInt('0x' + h) + 1n).toString(16);
const out = [];
const vec = (name, key, inputs, expected) => out.push({ name, key, inputs, expected });
const must = (cond, what) => { if (!cond) throw new Error(what); };

for (const [bits, T, round] of [[1024, 1024, 1], [2048, 4096, 2]]) {
  const m = tl.newModulus(bits);
  const seed = tl.seedFor(beacon, round, validator);
  const x = tl.deriveX(m.N, seed).toString(16);
  const y = tl.solveWithTrapdoor(m, seed, T);
  const c = tl.crack(m.N, seed, T);
  must(c.y === y, 'crack y == trapdoor y');
  const l = tl.challengePrime(m.N, x, y, T).toString(16);
  const p = `${bits}-t${T}`;
  const R = (name, inputs, valid) => {
    const i = { modulus: m.N, seed, t: String(T), y, p: m.p, ...inputs };
    const got = tl.verifyReveal(i.modulus, i.seed, i.t, i.y, i.p);
    must(got === valid, `${name}: reference says ${got}`);
    vec(`${p}-reveal-${name}`, 'verify-reveal', i, { valid });
  };
  const C = (name, inputs, valid, extra = {}) => {
    const i = { modulus: m.N, seed, t: String(T), y, proof: c.proof, ...inputs };
    const got = tl.verifyCrack(i.modulus, i.seed, i.t, i.y, i.proof);
    must(got === valid, `${name}: reference says ${got}`);
    vec(`${p}-crack-${name}`, 'verify-crack', i, { valid, ...extra });
  };
  vec(`${p}-derive-x`, 'derive-x', { modulus: m.N, seed }, { valid: true, x });
  const seed2 = tl.seedFor(beacon, round + 100, validator);
  vec(`${p}-derive-x-2`, 'derive-x', { modulus: m.N, seed: seed2 },
      { valid: true, x: tl.deriveX(m.N, seed2).toString(16) });
  R('valid-p', {}, true);
  R('valid-q', { p: m.q }, true);
  R('wrong-y', { y: bump(y) }, false);
  R('wrong-p', { p: bump(m.p) }, false);
  R('p-is-1', { p: '1' }, false);
  R('p-is-n', { p: m.N }, false);
  R('wrong-seed', { seed: tl.seedFor(beacon, round + 1, validator) }, false);
  R('wrong-t', { t: String(T + 1) }, false);
  R('garbage-p', { p: 'xyz' }, false);
  R('garbage-y', { y: 'zz' }, false);
  C('valid', {}, true, { x, l });
  C('corrupt-proof', { proof: bump(c.proof) }, false);
  C('corrupt-y', { y: bump(y) }, false);
  C('wrong-seed', { seed: tl.seedFor(beacon, round + 1, validator) }, false);
  C('wrong-t', { t: String(T + 1) }, false);
  C('proof-is-0', { proof: '0' }, false);
  C('y-is-n', { y: m.N }, false);
  C('garbage-y', { y: 'zz' }, false);
  C('garbage-proof', { proof: 'not-hex' }, false);
}
// The protocol's real size: 2048 bits, T = 2^27. A crack would take minutes,
// so its proof is made with the trapdoor: floor(2^T / l) = (2^T - r) / l
// exactly, so mod phi it is (2^T - r) * l^-1.
{
  const T = 2 ** 27;
  const m = tl.newModulus(2048);
  const seed = tl.seedFor(beacon, 3, validator);
  const N = BigInt('0x' + m.N), phi = (BigInt('0x' + m.p) - 1n) * (BigInt('0x' + m.q) - 1n);
  const x = tl.deriveX(m.N, seed);
  const y = tl.solveWithTrapdoor(m, seed, T);
  const l = tl.challengePrime(m.N, x.toString(16), y, T);
  const r = tl.modPow(2n, BigInt(T), l);
  const inv = (a, n) => { // extended Euclid
    let [g, ng, s, ns] = [a % n, n, 1n, 0n];
    while (ng) { const k = g / ng; [g, ng] = [ng, g - k * ng]; [s, ns] = [ns, s - k * ns]; }
    if (g !== 1n) throw new Error('l divides phi');
    return ((s % n) + n) % n;
  };
  const e = (((tl.modPow(2n, BigInt(T), phi) - r) % phi + phi) % phi) * inv(l, phi) % phi;
  const proof = tl.modPow(x, e, N).toString(16);
  must(tl.verifyReveal(m.N, seed, String(T), y, m.p), 'big reveal');
  must(tl.verifyCrack(m.N, seed, String(T), y, proof), 'big crack');
  const i = { modulus: m.N, seed, t: String(T) };
  vec('2048-t2^27-reveal-valid', 'verify-reveal', { ...i, y, p: m.p }, { valid: true, x: x.toString(16) });
  vec('2048-t2^27-crack-valid', 'verify-crack', { ...i, y, proof },
      { valid: true, x: x.toString(16), l: l.toString(16) });
}
// A fixed challenge prime from the reference's own test.
const fixedL = tl.challengePrime('ab', 'cd', 'ef', 10).toString(16);

const bin = (s) => {
  if (s.length <= 64) return `<<"${s}">>`;
  const lines = s.match(/.{1,64}/g).map((l) => `                    "${l}"`);
  return `\n                <<\n${lines.join('\n')}\n                >>`;
};
const term = (v) => typeof v === 'boolean' ? String(v) : bin(v);
const map = (o, ind) => '#{\n' + Object.entries(o)
  .map(([k, v]) => `${ind}    <<"${k}">> =>${term(v).startsWith('\n') ? '' : ' '}${term(v)}`).join(',\n') + `\n${ind}}`;
console.log('timelock_vectors() ->\n    [');
console.log(out.map((v) => `        {\n            <<"${v.name}">>,\n            <<"${v.key}">>,\n` +
  `            ${map(v.inputs, '            ')},\n            ${map(v.expected, '            ')}\n        }`)
  .join(',\n'));
console.log('    ].\n');
console.log(`%% @doc The reference's challenge prime for N = ab, x = cd, y = ef, T = 10.\nfixed_challenge_prime() ->\n    {{<<"ab">>, <<"cd">>, <<"ef">>, 10}, <<"${fixedL}">>}.`);
