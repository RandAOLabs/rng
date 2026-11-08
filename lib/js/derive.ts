// derive.ts: deterministic bytes from a seed, SHA-256 in counter mode
// (docs/SPEC.md, "hyperbeam/rng/v1/derive").
//
// No imports and only erasable TypeScript, so Node runs this file directly.

const encoder = new TextEncoder();

export async function deriveBytes(seed: string, counter: number, byteCount: number) {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("counter must be a non-negative integer");
  if (!Number.isSafeInteger(byteCount) || byteCount < 1 || byteCount > 1024) throw new Error("bytes must be between 1 and 1024");
  const seedBytes = encoder.encode(seed);
  const prefix = encoder.encode(`hyperbeam/rng/v1/derive|${seedBytes.length}|`);
  const output: number[] = [];
  for (let block = counter; output.length < byteCount; block += 1) {
    const suffix = encoder.encode(`|${block}`);
    const input = new Uint8Array(prefix.length + seedBytes.length + suffix.length);
    input.set(prefix);
    input.set(seedBytes, prefix.length);
    input.set(suffix, prefix.length + seedBytes.length);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    output.push(...digest);
  }
  return Array.from(output.slice(0, byteCount), (value) => value.toString(16).padStart(2, "0")).join("");
}

// Fast tier per-request values (docs/SPEC.md, "Request value"). A round record
// names its rule in `derivation`; one without it predates v2 and uses v1.
//   v1: SHA-256("hyperbeam/rng/v1/request|" || V || "|" || Q)
//   v2: SHA-256("hyperbeam/rng/fast/v2/request|" || V || "|" || requester || "|" || Q)
// v2 binds the requester, as Any-Honest does: under v1 two requesters using
// the same Request-Id in one round got the same value.
export const FAST_REQUEST_V1 = "hyperbeam/rng/v1/request";
export const FAST_REQUEST_V2 = "hyperbeam/rng/fast/v2/request";

export function fastRequestPreimage(round: { value: string; derivation?: string | null }, requester: string, requestId: string) {
  const rule = round.derivation ?? FAST_REQUEST_V1;
  if (rule === FAST_REQUEST_V1) return `${FAST_REQUEST_V1}|${round.value}|${requestId}`;
  if (rule === FAST_REQUEST_V2) return `${FAST_REQUEST_V2}|${round.value}|${requester}|${requestId}`;
  throw new Error(`unknown fast-tier request derivation ${rule}`);
}

export async function fastRequestValue(round: { value: string; derivation?: string | null }, requester: string, requestId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(fastRequestPreimage(round, requester, requestId))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
