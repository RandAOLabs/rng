// Time-lock puzzles for the `timelock` tier (SPEC.md §2.3-2.5): the reference
// implementation the validator daemon uses and the timelock@1.0 device's test
// vectors are generated from.
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const hex = (n) => n.toString(16);
const big = (h) => BigInt('0x' + h);

export function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** First `bits` bits of SHA-256(s|0) || SHA-256(s|1) || ... as a BigInt. */
export function expand(seed, bits) {
  const parts = [];
  for (let k = 0; parts.length * 256 < bits; k++) parts.push(sha256(`${seed}|${k}`));
  const all = BigInt('0x' + Buffer.concat(parts).toString('hex'));
  return all >> BigInt(parts.length * 256 - bits);
}

export const seedFor = (beacon, round, validator) => `${beacon}|${round}|${validator}`;

/** The round's puzzle input for modulus N (hex in, BigInt out). */
export function deriveX(modulusHex, seed) {
  const N = big(modulusHex);
  const bits = N.toString(2).length;
  const v = expand(seed, bits + 64) % N;
  return (v * v) % N;
}

/** A fresh modulus with its trapdoor. */
export function newModulus(bits = 2048) {
  for (;;) {
    const p = crypto.generatePrimeSync(bits / 2, { bigint: true });
    const q = crypto.generatePrimeSync(bits / 2, { bigint: true });
    const N = p * q;
    if (p !== q && N.toString(2).length === bits) return { N: hex(N), p: hex(p), q: hex(q) };
  }
}

/** y = x^(2^T) mod N, instantly, with the trapdoor. */
export function solveWithTrapdoor({ N, p, q }, seed, T) {
  const n = big(N), P = big(p), Q = big(q);
  const phi = (P - 1n) * (Q - 1n);
  const x = deriveX(N, seed);
  return hex(modPow(x, modPow(2n, BigInt(T), phi), n));
}

/** SPEC 2.4 step 2: what the device checks for a reveal. */
export function verifyReveal(modulusHex, seed, T, yHex, pHex) {
  try {
    const N = big(modulusHex), p = big(pHex), y = big(yHex);
    if (p <= 1n || p >= N || N % p !== 0n) return false;
    const q = N / p;
    const phi = (p - 1n) * (q - 1n);
    return modPow(deriveX(modulusHex, seed), modPow(2n, BigInt(T), phi), N) === y;
  } catch { return false; }
}

// --- Wesolowski (SPEC 2.5) -------------------------------------------------

const SMALL_PRIMES = (() => {
  const out = [];
  for (let n = 2; n < 1000; n++) if (out.every((p) => n % p !== 0)) out.push(n);
  return out;
})();
const MR_BASES = SMALL_PRIMES.slice(0, 20).map(BigInt);

export function isProbablePrime(n) {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES) {
    const P = BigInt(p);
    if (n === P) return true;
    if (n % P === 0n) return false;
  }
  let d = n - 1n, s = 0;
  while ((d & 1n) === 0n) { d >>= 1n; s++; }
  outer: for (const a of MR_BASES) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) continue outer;
    }
    return false;
  }
  return true;
}

export function challengePrime(modulusHex, xHex, yHex, T) {
  const h = sha256(`rng/wesolowski|${modulusHex}|${xHex}|${yHex}|${T}`);
  let c = BigInt('0x' + h.subarray(0, 16).toString('hex')) | (1n << 127n) | 1n;
  while (!isProbablePrime(c)) c += 2n;
  return c;
}

/**
 * Crack a puzzle without the trapdoor: T sequential squarings, computing the
 * Wesolowski proof alongside (long division of 2^T by l, bit by bit).
 * `onProgress(done)` is called every 2^16 steps.
 */
export function crack(modulusHex, seed, T, onProgress) {
  const N = big(modulusHex);
  const x = deriveX(modulusHex, seed);
  let y = x;
  for (let i = 0; i < T; i++) {
    y = (y * y) % N;
    if (onProgress && (i & 0xffff) === 0) onProgress(i);
  }
  const xHex = hex(x), yHex = hex(y);
  const l = challengePrime(modulusHex, xHex, yHex, T);
  // proof = x^floor(2^T / l): walk the bits of the quotient from the top.
  let proof = 1n, r = 1n;
  for (let i = 0; i < T; i++) {
    const b = (2n * r) / l;
    r = (2n * r) % l;
    proof = (proof * proof) % N;
    if (b) proof = (proof * x) % N;
  }
  return { y: yHex, proof: hex(proof) };
}

/** SPEC 2.4 step 3: what the device checks for a crack. */
export function verifyCrack(modulusHex, seed, T, yHex, proofHex) {
  try {
    const N = big(modulusHex);
    const x = deriveX(modulusHex, seed);
    const y = big(yHex), proof = big(proofHex);
    if (y <= 0n || y >= N || proof <= 0n || proof >= N) return false;
    const l = challengePrime(modulusHex, hex(x), yHex, T);
    const r = modPow(2n, BigInt(T), l);
    return (modPow(proof, l, N) * modPow(x, r, N)) % N === y;
  } catch { return false; }
}

/** The round value (SPEC 2.4 step 4); outputs: { address: yHex }. */
export function roundValue(beacon, round, outputs) {
  const ys = Object.keys(outputs).sort().map((a) => outputs[a]);
  return crypto.createHash('sha256').update(`rng/timelock|${beacon}|${round}|${ys.join('|')}`).digest('hex');
}
