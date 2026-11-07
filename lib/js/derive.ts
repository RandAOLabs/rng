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
