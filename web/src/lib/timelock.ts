// Browser port of provider/timelock.mjs's checks (SPEC.md §2.3-2.5), so the
// page verifies every time-lock reveal and crack itself.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const big = (h: string) => BigInt('0x' + h);
const hex = (n: bigint) => n.toString(16);

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

export const seedFor = (beacon: string, round: number, validator: string) => `${beacon}|${round}|${validator}`;

export function deriveX(modulusHex: string, seed: string): bigint {
  const N = big(modulusHex);
  const v = expand(seed, N.toString(2).length + 64) % N;
  return (v * v) % N;
}

export function verifyReveal(modulusHex: string, seed: string, T: number, yHex: string, pHex: string): boolean {
  try {
    const N = big(modulusHex), p = big(pHex);
    if (p <= 1n || p >= N || N % p !== 0n) return false;
    const phi = (p - 1n) * (N / p - 1n);
    return modPow(deriveX(modulusHex, seed), modPow(2n, BigInt(T), phi), N) === big(yHex);
  } catch { return false; }
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

function challengePrime(N: string, x: string, y: string, T: number): bigint {
  const h = bytesToHex(sha256(utf8ToBytes(`rng/wesolowski|${N}|${x}|${y}|${T}`))).slice(0, 32);
  let c = BigInt('0x' + h) | (1n << 127n) | 1n;
  while (!isProbablePrime(c)) c += 2n;
  return c;
}

export function verifyCrack(modulusHex: string, seed: string, T: number, yHex: string, proofHex: string): boolean {
  try {
    const N = big(modulusHex), x = deriveX(modulusHex, seed);
    const l = challengePrime(modulusHex, hex(x), yHex, T);
    return (modPow(big(proofHex), l, N) * modPow(x, modPow(2n, BigInt(T), l), N)) % N === big(yHex);
  } catch { return false; }
}

export function roundValue(beacon: string, round: number, outputs: Record<string, string>): string {
  const ys = Object.keys(outputs).sort().map((a) => outputs[a]);
  return bytesToHex(sha256(utf8ToBytes(`rng/timelock|${beacon}|${round}|${ys.join('|')}`)));
}
