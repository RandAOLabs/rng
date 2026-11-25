// Where the fast tier publishes a request's round. beacon.lua keeps the last
// GUARD_MS of request ids in 256 shards, `beaconseen-<n>`, each a JSON object
// "<requester>|<request id>" -> [round, forget-at]; n is FNV-1a (32-bit) of
// that key mod 256 (beacon.lua seenShard: change them together).

export const FAST_SEEN_SHARDS = 256;
export const FAST_SEEN_PREFIX = "beaconseen-";

/** FNV-1a (32-bit) of `key`'s UTF-8 bytes, mod 256. */
export function fastSeenShard(key: string): number {
  let h = 2166136261;
  for (const b of new TextEncoder().encode(key)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h % FAST_SEEN_SHARDS;
}

/** The published key holding a request's round: `beaconseen-<n>`. */
export function fastSeenKey(requester: string, requestId: string): string {
  return FAST_SEEN_PREFIX + fastSeenShard(`${requester}|${requestId}`);
}

/** The round a request was bound to, from its shard's parsed JSON, or undefined. */
export function fastSeenRound(shard: Record<string, [number, number]> | null | undefined,
  requester: string, requestId: string): number | undefined {
  const entry = shard?.[`${requester}|${requestId}`];
  return Array.isArray(entry) ? Number(entry[0]) : undefined;
}
