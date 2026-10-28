// Browser port of provider/timelock.mjs's checks (SPEC.md §2.3-2.6), so the
// page verifies every time-lock reveal and crack itself.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const hex = (n: bigint) => n.toString(16);
const parseHex = (h: unknown) => (typeof h === 'string' && /^(0|[1-9a-f][0-9a-f]*)$/.test(h) ? BigInt('0x' + h) : null);

export function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function expand(seed: string, bits: number): bigint {
  let all = '';
  for (let k = 0; all.length * 4 < bits; k++) all += bytesToHex(sha256(utf8ToBytes(`${seed}|${k}`)));
  return BigInt('0x' + all) >> BigInt(all.length * 4 - bits);
}

// The RSA-2048 challenge number (SPEC 2.3) and g.
const N = BigInt('0x' +
  'c7970ceedcc3b0754490201a7aa613cd73911081c790f5f1a8726f463550bb5b' +
  '7ff0db8e1ea1189ec72f93d1650011bd721aeeacc2acde32a04107f0648c2813' +
  'a31f5b0b7765ff8b44b4b6ffc93384b646eb09c7cf5e8592d40ea33c80039f35' +
  'b4f14a04b51f7bfd781be4d1673164ba8eb991c2c4d730bbbe35f592bdef524a' +
  'f7e8daefd26c66fc02c479af89d64d373f442709439de66ceb955f3ea37d5159' +
  'f6135809f85334b5cb1813addc80cd05609f10ac6a95ad65872c909525bdad32' +
  'bc729592642920f24c61dc5b3c3b7923e56b16a4d9d373d8721f24a3fc0f1b31' +
  '31f55615172866bccc30f95054c824e733a5eb6817f7bc16399d48c6361cc7e5');
const G = (() => { const v = expand('rng/timelock/g', 2112) % N; return (v * v) % N; })();
const canonical = (y: bigint) => (y <= N - y ? y : N - y);

/** g^alpha = c, then y* of h^alpha; null if it does not verify. */
function verifyReveal(cHex: string, alphaHex: string | undefined, hHex: string): bigint | null {
  const c = parseHex(cHex), alpha = parseHex(alphaHex), h = parseHex(hHex);
  if (c === null || c <= 0n || c >= N || h === null || h <= 0n || h >= N) return null;
  if (alpha === null || alpha.toString(2).length > 512 || modPow(G, alpha, N) !== c) return null;
  return canonical(modPow(h, alpha, N));
}

const SMALL: number[] = [];
for (let n = 2; n < 1000; n++) if (SMALL.every((p) => n % p !== 0)) SMALL.push(n);
const BASES = SMALL.slice(0, 20).map(BigInt);

function isProbablePrime(n: bigint): boolean {
  for (const p of SMALL) { const P = BigInt(p); if (n === P) return true; if (n % P === 0n) return false; }
  let d = n - 1n, s = 0;
  while ((d & 1n) === 0n) { d >>= 1n; s++; }
  outer: for (const a of BASES) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < s; i++) { x = (x * x) % n; if (x === n - 1n) continue outer; }
    return false;
  }
  return true;
}

function challengePrime(x: string, y: string, T: number): bigint {
  const h = bytesToHex(sha256(utf8ToBytes(`rng/wesolowski|${x}|${y}|${T}`))).slice(0, 32);
  let c = BigInt('0x' + h) | (1n << 127n) | 1n;
  while (!isProbablePrime(c)) c += 2n;
  return c;
}

/** Wesolowski with x = c (SPEC 2.5): y* or null. */
function verifyCrack(xHex: string, T: number, yHex: string, proofHex: string | undefined): bigint | null {
  const x = parseHex(xHex), y = parseHex(yHex), proof = parseHex(proofHex);
  if (x === null || y === null || proof === null || [x, y, proof].some((v) => v <= 0n || v >= N)) return null;
  const l = challengePrime(xHex, yHex, T);
  return (modPow(proof, l, N) * modPow(x, modPow(2n, BigInt(T), l), N)) % N === y ? canonical(y) : null;
}

export type Output = { y: string; via: 'reveal' | 'crack'; alpha?: string; proof?: string; cracker?: string };

/** One output of a round against its commit c: y* hex, or null. A crack may be for N - y. */
export function checkOutput(c: string, o: Output, T: number, h: string): string | null {
  const y = parseHex(o.y);
  if (y === null || y <= 0n || y >= N) return null;
  const want = canonical(y);
  if (o.via === 'reveal') return verifyReveal(c, o.alpha, h) === want ? hex(want) : null;
  for (const ys of [o.y, hex(N - y)]) if (verifyCrack(c, T, ys, o.proof) === want) return hex(want);
  return null;
}

export function roundValue(beacon: string, round: number, outputs: Record<string, string>): string {
  const ys = Object.keys(outputs).sort().map((a) => outputs[a]);
  return bytesToHex(sha256(utf8ToBytes(`rng/timelock|${beacon}|${round}|${ys.join('|')}`)));
}

type Round = { round: number; T?: number; h?: string; commits: Record<string, string>; outputs: Record<string, Output>; value: string };

/** Every reveal and crack of a published round, then its value. h: the beacon's for the round's T. */
export function verifyRound(self: string, params: { T: number; h?: string }, r: Round): boolean {
  const T = r.T ?? params.T, h = r.h ?? (T === params.T ? params.h : undefined);
  if (!h) return false;
  const ys: Record<string, string> = {};
  for (const [a, o] of Object.entries(r.outputs)) {
    const y = checkOutput(r.commits[a], o, T, h);
    if (y === null) return false;
    ys[a] = y;
  }
  return roundValue(self, r.round, ys) === r.value;
}
