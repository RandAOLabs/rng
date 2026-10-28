// Emits time-lock interop vectors for HyperBEAM's timelock@1.0 device from the
// reference implementation (provider/timelock.mjs), as an Erlang function body
// for dev_timelock_test_vectors:timelock_vectors/0.
//   node test/gen-timelock-vectors.mjs > vectors.erl.txt   (from the rng repo)
// Every expected answer is checked against the reference before it is written.
import * as tl from '../provider/timelock.mjs';

const T = 1024; // small; the device takes any t up to 2^32
const big = (h) => BigInt('0x' + h);
const hex = (n) => n.toString(16);
const bump = (h) => hex(big(h) + 1n);
const out = [];
const vec = (name, key, inputs, expected) => out.push({ name, key, inputs, expected });
const must = (cond, what) => { if (!cond) throw new Error(what); };
// Fixed secrets, so the vectors are reproducible.
const alphaFor = (s) => hex(tl.expand(`rng/vector/alpha|${s}`, 256));

const { y: h, proof: hProof } = tl.crack(tl.G_HEX, T);
vec('generator', 'generator', {}, { valid: true, g: tl.G_HEX, n: tl.N_HEX });

const R = (name, inputs, valid) => {
  const got = tl.verifyReveal(inputs.c, inputs.alpha, inputs.h);
  must(got.valid === valid, `reveal ${name}: reference says ${got.valid}`);
  vec(`t${T}-reveal-${name}`, 'verify-reveal', inputs, valid ? { valid, y: got.y } : { valid });
};
const C = (name, inputs, valid) => {
  const got = tl.verifyCrack(inputs.x, inputs.t, inputs.y, inputs.proof);
  must(got.valid === valid, `crack ${name}: reference says ${got.valid}`);
  const l = valid ? { l: hex(tl.challengePrime(inputs.x, inputs.y, inputs.t)) } : {};
  vec(`t${T}-crack-${name}`, 'verify-crack', inputs, valid ? { valid, y: got.y, ...l } : { valid });
};

const alpha = alphaFor(1);
const c = tl.commit(alpha);
const r = { c, alpha, h };
R('valid', r, true);
const wide = hex((1n << 512n) - 1n);
R('valid-512-bit-alpha', { c: tl.commit(wide), alpha: wide, h }, true);
R('valid-alpha-0', { c: '1', alpha: '0', h }, true);
R('valid-other-h', { ...r, h: bump(h) }, true); // h is the beacon's to check, at Configure
R('wrong-alpha', { ...r, alpha: alphaFor(2) }, false);
R('alpha-plus-1', { ...r, alpha: bump(alpha) }, false);
R('wrong-c', { ...r, c: bump(c) }, false);
R('c-is-0', { ...r, c: '0' }, false);
R('c-is-n', { ...r, c: tl.N_HEX }, false);
R('c-plus-n', { ...r, c: hex(big(c) + tl.N) }, false);
R('h-is-0', { ...r, h: '0' }, false);
R('h-is-n', { ...r, h: tl.N_HEX }, false);
R('alpha-513-bits', { c: tl.commit(hex(1n << 512n)), alpha: hex(1n << 512n), h }, false);
R('garbage-alpha', { ...r, alpha: 'xyz' }, false);
R('garbage-c', { ...r, c: 'zz' }, false);
R('uppercase-c', { ...r, c: c.toUpperCase() }, false);
R('leading-zero-c', { ...r, c: '0' + c }, false);

const k = tl.crack(c, T);
must(tl.verifyReveal(c, alpha, h).y === hex(tl.canonical(big(k.y))), 'reveal y == canonical crack y');
const t = String(T);
const x = { x: c, t, y: k.y, proof: k.proof };
C('valid', x, true);
// N - y passes with its own challenge and a negated proof (l is odd); same y*.
const ny = hex(tl.N - big(k.y));
const nl = tl.challengePrime(c, ny, T);
C('valid-n-minus-y', { x: c, t, y: ny, proof: hex(tl.N - tl.modPow(big(c), 2n ** BigInt(T) / nl, tl.N)) }, true);
must(tl.verifyCrack(c, t, ny, out[out.length - 1].inputs.proof).y === tl.verifyCrack(c, t, k.y, k.proof).y, 'same y*');
C('valid-h-proof', { x: tl.G_HEX, t, y: h, proof: hProof }, true);
C('corrupt-proof', { ...x, proof: bump(k.proof) }, false);
C('corrupt-y', { ...x, y: bump(k.y) }, false);
C('n-minus-y-old-proof', { ...x, y: ny, proof: hex(tl.N - big(k.proof)) }, false);
C('wrong-x', { ...x, x: bump(c) }, false);
C('wrong-t', { ...x, t: String(T + 1) }, false);
C('t-is-2^32', { ...x, t: String(2 ** 32) }, false); // in range, wrong proof
C('t-over-2^32', { ...x, t: String(2 ** 32 + 1) }, false);
C('x-is-0', { ...x, x: '0' }, false);
C('x-is-n', { ...x, x: tl.N_HEX }, false);
C('y-is-0', { ...x, y: '0' }, false);
C('y-is-n', { ...x, y: tl.N_HEX }, false);
C('proof-is-0', { ...x, proof: '0' }, false);
C('proof-is-n', { ...x, proof: tl.N_HEX }, false);
C('garbage-y', { ...x, y: 'zz' }, false);
C('garbage-proof', { ...x, proof: 'not-hex' }, false);
C('garbage-t', { ...x, t: '1e3' }, false);

// A fixed challenge prime from the reference's own test.
const fixedL = tl.challengePrime('cd', 'ef', 10).toString(16);

const bin = (s) => {
  if (s.length <= 64) return `<<"${s}">>`;
  const lines = s.match(/.{1,64}/g).map((l) => `                    "${l}"`);
  return `\n                <<\n${lines.join('\n')}\n                >>`;
};
const term = (v) => typeof v === 'boolean' ? String(v) : bin(v);
const map = (o, ind) => !Object.keys(o).length ? '#{}' : '#{\n' + Object.entries(o)
  .map(([k, v]) => `${ind}    <<"${k}">> =>${term(v).startsWith('\n') ? '' : ' '}${term(v)}`).join(',\n') + `\n${ind}}`;
console.log('timelock_vectors() ->\n    [');
console.log(out.map((v) => `        {\n            <<"${v.name}">>,\n            <<"${v.key}">>,\n` +
  `            ${map(v.inputs, '            ')},\n            ${map(v.expected, '            ')}\n        }`)
  .join(',\n'));
console.log('    ].\n');
console.log(`%% @doc The reference's challenge prime for x = cd, y = ef, T = 10.\nfixed_challenge_prime() ->\n    {{<<"cd">>, <<"ef">>, 10}, <<"${fixedL}">>}.`);
