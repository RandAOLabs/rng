// history.ts: read a process's past from its per-slot results (deploy/README.md,
// "History"); the browser port of validator/history.mjs.
//
// The processes keep only a bounded recent window in state. Anything older is
// readable at the slot that produced it (<pid>~process@1.0/compute&slot=<n>/<key>):
// each process publishes a bounded index (beaconhistory, timelockhistory,
// fairhistory) of recent rounds / sessions -> slot, and past it a round is found
// by binary search over slots on the monotone `beaconinfo.round`.
//
// No imports and only erasable TypeScript, so Node runs this file directly.

/** The parsed JSON at `slot` (null: now) under `key`, or null when there is none. */
export type SlotReader = (slot: number | null, key: string) => Promise<unknown>;
export type IndexEntry = [string | number, number?, string?];
export type RoundHit<T> = { slot: number; record: T; abandoned: boolean };

/** A slot the node no longer keeps (HTTP 410): it retains only recent computed
 * slots. Not a protocol failure: the record may exist, this node cannot serve it. */
export class NotRetainedError extends Error {
  constructor(what: string) {
    super(`${what} is not retained by this node (HTTP 410: it keeps only recent computed slots)`);
    this.name = "NotRetainedError";
  }
}

/** A reader for a live node. */
export function httpReader(node: string, pid: string, fetchImpl: typeof fetch = fetch): SlotReader {
  const base = `${node.replace(/\/$/, "")}/${pid}~process@1.0`;
  return async (slot, key) => {
    const at = slot == null ? "now" : `compute&slot=${slot}`;
    const response = await fetchImpl(`${base}/${at}/${key}`, { cache: "no-store", headers: { accept: "application/ao" } });
    if (response.status === 410 && slot != null) throw new NotRetainedError(`slot ${slot}`);
    if (!response.ok) return null;
    const text = await response.text();
    try { return JSON.parse(text) as unknown; } catch { return text; }
  };
}

/** The newest index entry for `id`, or null. */
export async function indexLookup(read: SlotReader, indexKey: string, id: string | number) {
  const index = (await read(null, indexKey)) as { rounds?: IndexEntry[]; entries?: IndexEntry[] } | null;
  const entries = index?.rounds ?? index?.entries ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const [key, slot, kind] = entries[i];
    if (String(key) === String(id)) return { slot: slot ?? null, kind: kind ?? null };
  }
  return null;
}

/** The smallest slot in [lo, hi] where the monotone `test` holds, or null. */
export async function firstSlot(lo: number, hi: number, test: (slot: number) => Promise<boolean>) {
  let found: number | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await test(mid)) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return found;
}

function recordFor<T>(value: unknown, round: number): T | null {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return (list.find((r) => r && Number((r as { round?: unknown }).round) === round) as T | undefined) ?? null;
}

/**
 * A round's record: the index first, then a binary search over slots 1..latest
 * for the first whose `infoKey` shows round >= `round`, checking it and the
 * next `scan` slots (a cracked Any-Honest round can finalize after later ones).
 */
export async function findRound<T>(read0: SlotReader, opts: { round: number; indexKey?: string;
  keys: (round: number) => string[]; infoKey?: string; latest?: number; scan?: number }): Promise<RoundHit<T> | null> {
  const { indexKey, keys, infoKey = "beaconinfo", scan = 0 } = opts;
  const round = opts.round;
  // Unretained (410) slots read as nothing; if the round is not found and the
  // node dropped slots on the way, say so instead of "not found".
  let gone = false;
  const read: SlotReader = async (slot, key) => {
    try { return await read0(slot, key); } catch (e) {
      if (e instanceof NotRetainedError) { gone = true; return null; }
      throw e;
    }
  };
  const missing = () => { if (gone) throw new NotRetainedError(`round ${round}`); return null; };
  const look = async (slot: number) => {
    for (const key of keys(round)) {
      const record = recordFor<T>(await read(slot, key), round);
      if (record) return { slot, record, abandoned: key.endsWith("abandoned") };
    }
    return null;
  };
  const hit = indexKey ? await indexLookup(read, indexKey, round) : null;
  if (hit?.slot != null) {
    const found = await look(hit.slot);
    if (found) return found;
  }
  const top = opts.latest ?? Number(await read(null, "at-slot"));
  if (!Number.isSafeInteger(top) || top < 1) return null;
  const start = await firstSlot(1, top, async (s) => Number((await read(s, infoKey) as { round?: unknown } | null)?.round ?? -1) >= round);
  if (start == null) return null; // no slot reached the round: it has not happened
  for (let s = start; s <= Math.min(top, start + scan); s++) {
    const found = await look(s);
    if (found) return found;
  }
  return missing();
}
