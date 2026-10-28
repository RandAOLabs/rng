// Everything the page checks for itself: BLS signatures, the value chain,
// and the same SHA-256 stream lib/rng.lua uses, so a roll shown here matches
// what a process would draw from the same value.
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
export const sha256hex = (s: string) => bytesToHex(sha256(latin1(s)));

/** Does `signature` verify for `message` under the committee's group key? */
export function verifySignature(groupKey: string, message: string, signature: string): boolean {
  try {
    const sigs = bls.longSignatures;
    return sigs.verify(bls.G2.Point.fromHex(signature), sigs.hash(utf8ToBytes(message)), bls.G1.Point.fromHex(groupKey));
  } catch {
    return false;
  }
}

/** The beacon's round value and one request's value, as beacon.lua derives them. */
export const roundValue = (signature: string) => sha256hex(`round|${signature}`);
export const requestValue = (roundValueHex: string, requester: string, requestId: string) => sha256hex(`${roundValueHex}|${requester}|${requestId}`);

/** lib/rng.lua's stream: block k = SHA-256(SHA-256("rng/v1|" .. material) .. k). */
export function stream(material: string) {
  const seed = sha256(latin1(`rng/v1|${material}`));
  let block = 0;
  let words: number[] = [];
  const u32 = () => {
    if (words.length === 0) {
      const k = latin1(String(block++));
      const buf = new Uint8Array(seed.length + k.length);
      buf.set(seed);
      buf.set(k, seed.length);
      const d = sha256(buf);
      const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
      for (let i = 0; i < 8; i++) words.push(view.getUint32(i * 4));
    }
    return words.shift()!;
  };
  const int = (lo: number, hi: number) => {
    const range = hi - lo + 1;
    if (range === 1) return lo;
    const limit = Math.floor(2 ** 32 / range) * range;
    let x = u32();
    while (x >= limit) x = u32();
    return lo + (x % range);
  };
  return { u32, int };
}

/** A beacon result's dice roll, exactly as `r:int(1, 6)` gives it in a process. */
export const dieFor = (valueHex: string) => stream(`beacon|${valueHex}`).int(1, 6);
