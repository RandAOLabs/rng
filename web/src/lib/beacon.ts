// Reads: unsigned GETs of the keys the beacon publishes after every message.
import { useEffect, useState } from 'react';
import { BEACON, NODE } from './config';

export type Member = { address: string; index: number };
export type BeaconInfo = {
  round: number; nextRound: number; nextRoundAt: number; pendingCount: number;
  threshold: number; committee: Member[]; groupKey: string; roundMessage: string;
  price: { beacon: number }; token: string; unit: number; protocolAccrued: number;
};
export type Round = { signature: string; value: string; signers: string[] };
export type BeaconState = {
  self: string; round: number; lastRoundAt: number; cadenceMs: number;
  rounds: Record<string, Round>; balances: Record<string, number>;
  accrued: Record<string, number>; protocolAccrued: number;
  equivocations: Record<string, number>; committee: Record<string, number>; groupKey: string;
};

export async function readKey<T>(key: string, pid = BEACON): Promise<T> {
  const res = await fetch(`${NODE}/${pid}~process@1.0/now/${key}`, { headers: { accept: 'text/plain' } });
  if (!res.ok) throw new Error(`The node answered ${res.status} for ${key}.`);
  return JSON.parse(await res.text()) as T;
}

/** The beacon's published state, refreshed every `everyMs`. */
export function useBeacon(everyMs = 3000) {
  const [info, setInfo] = useState<BeaconInfo | null>(null);
  const [state, setState] = useState<BeaconState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const [i, s] = await Promise.all([readKey<BeaconInfo>('beaconinfo'), readKey<BeaconState>('beaconstate')]);
        if (!live) return;
        setInfo(i);
        setState(s);
        setError(null);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const t = setInterval(tick, everyMs);
    return () => { live = false; clearInterval(t); };
  }, [everyMs]);
  return { info, state, error };
}

/** Finalized rounds, newest first. */
export function recentRounds(state: BeaconState | null): Array<Round & { round: number }> {
  if (!state) return [];
  return Object.entries(state.rounds ?? {})
    .map(([r, v]) => ({ round: Number(r), ...v }))
    .sort((a, b) => b.round - a.round);
}

export const short = (s: string, n = 6) => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

/** Rounds seen since the page opened, newest first, up to `keep`: the beacon only publishes its last few. */
export function useRoundHistory<T extends { round: number }>(latest: T[], keep = 100): T[] {
  const [all, setAll] = useState<T[]>([]);
  useEffect(() => {
    if (!latest.length) return;
    setAll((prev) => {
      const byRound = new Map(prev.map((r) => [r.round, r]));
      for (const r of latest) byRound.set(r.round, r);
      return [...byRound.values()].sort((a, b) => b.round - a.round).slice(0, keep);
    });
  }, [latest, keep]);
  return all;
}
