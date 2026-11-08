// history.mjs: read a process's past from its per-slot results (deploy/README.md, "History").
//
// The processes keep only a bounded recent window in state. Everything older
// stays readable on HyperBEAM at the slot that produced it:
//   <node>/<pid>~process@1.0/compute&slot=<n>/<key>
// Each process publishes a bounded index (beaconhistory, timelockhistory,
// fairhistory) mapping recent rounds / sessions to their slot; past it, a
// round is found by binary search over slots on the monotone `beaconinfo.round`.
//
// `read(slot, key)` returns the parsed JSON at that slot (slot null: now), or
// null when there is none. `httpReader` builds one for a live node; tests pass
// a mocked slot store.

/** A slot the node no longer keeps (HTTP 410): it retains only recent computed
 * slots. Not a protocol failure: the record may exist, this node cannot serve it. */
export class NotRetainedError extends Error {
  constructor(what) {
    super(`${what} is not retained by this node (HTTP 410: it keeps only recent computed slots)`);
    this.name = 'NotRetainedError';
  }
}

/** A reader for a live node: GET .../now/<key> or .../compute&slot=<n>/<key>. */
export function httpReader(node, pid, fetchImpl = fetch) {
  const base = `${node.replace(/\/$/, '')}/${pid}~process@1.0`;
  return async (slot, key) => {
    const at = slot == null ? 'now' : `compute&slot=${slot}`;
    const res = await fetchImpl(`${base}/${at}/${key}`, { headers: { accept: 'application/ao' } });
    if (res.status === 410 && slot != null) throw new NotRetainedError(`slot ${slot}`);
    if (!res.ok) return null;
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  };
}

/** The newest index entry for `id` ([id, slot, kind?] lists), or null. */
export async function indexLookup(read, indexKey, id) {
  const index = await read(null, indexKey);
  const entries = index?.rounds ?? index?.entries ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const [key, slot, kind] = entries[i];
    if (String(key) === String(id)) return { slot: slot ?? null, kind: kind ?? null };
  }
  return null;
}

/** The smallest slot in [lo, hi] where `test(slot)` holds, `test` monotone (false ... true), or null. */
export async function firstSlot(lo, hi, test) {
  let found = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await test(mid)) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return found;
}

const recordFor = (value, round) => {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.find((r) => r && Number(r.round) === round) ?? null;
};

/**
 * A round's record, wherever it is. `keys(round)`: the published keys that
 * may hold it at its slot (e.g. ['beaconround', 'beaconabandoned'], or
 * [`beaconround-${round % 8}`, 'beaconabandoned'] for Any-Honest). Tries the
 * index, then binary-searches slots 1..latest for the first one whose
 * `infoKey` shows round >= `round`, checking it and the next `scan` slots
 * (a cracked Any-Honest round can finalize after later ones).
 * Returns { slot, record, abandoned } or null.
 */
export async function findRound(read0, { round, indexKey, keys, infoKey = 'beaconinfo', latest, scan = 0 }) {
  // Unretained (410) slots read as nothing; if the round is not found and the
  // node dropped slots on the way, say so instead of "not found".
  let gone = false;
  const read = async (slot, key) => {
    try { return await read0(slot, key); } catch (e) {
      if (e instanceof NotRetainedError) { gone = true; return null; }
      throw e;
    }
  };
  const missing = () => { if (gone) throw new NotRetainedError(`round ${round}`); return null; };
  const look = async (slot) => {
    for (const key of keys(round)) {
      const record = recordFor(await read(slot, key), round);
      if (record) return { slot, record, abandoned: key.endsWith('abandoned') };
    }
    return null;
  };
  const hit = indexKey ? await indexLookup(read, indexKey, round) : null;
  if (hit?.slot != null) {
    const found = await look(hit.slot);
    if (found) return found;
  }
  const top = latest ?? Number(await read(null, 'at-slot'));
  if (!Number.isSafeInteger(top) || top < 1) return null;
  const start = await firstSlot(1, top, async (s) => Number((await read(s, infoKey))?.round ?? -1) >= round);
  if (start == null) return null; // no slot reached the round: it has not happened
  for (let s = start; s <= Math.min(top, start + scan); s++) {
    const found = await look(s);
    if (found) return found;
  }
  return missing();
}
