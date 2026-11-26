export const PACE_WINDOW_MS = 30_000;
const ROUND_STALE_MS = 6_000;
const UNREACHABLE_MS = 6_000;

export type Recent = { round: number; value: string; opened?: number; finalizedAt?: number };
type Round = Recent & { commits: Record<string, string>; outputs: Record<string, { via: "reveal" | "crack" }> };
export type InFlight = { round: number; committed?: unknown; revealed?: unknown };
export type Validator = { address: string; ready?: boolean; suspended?: boolean; exiting?: boolean };
type Outage = { at: number; gapMs: number };
export type Beacon = {
  configured: boolean; process?: string; checkedAt?: string; proofValid?: boolean; latest?: Round;
  recent?: Recent[]; validators?: Validator[]; open?: InFlight; revealing?: InFlight[]; lastOutage?: Outage;
};
type Verified = { beacon: Beacon & { latest: Round }; at: number; checkedAt: number; receivedAt: number };
type Pace = { coverageFrom: number; lastSample: Set<number>; rounds: Map<number, number>; rate?: number };
export type BeaconView = {
  now: number; checkedAt?: number; issue?: "proof" | "awaiting" | "unconfigured";
  failedSince?: number; lastVerified?: Verified; lastOutage?: Outage; pace?: Pace;
};

function observedPace(previous: Pace | undefined, rows: Recent[], checkedAt: number): Pace | undefined {
  const sample = new Map<number, number>();
  for (const row of rows) {
    if (row.finalizedAt && row.finalizedAt <= checkedAt) sample.set(row.round, row.finalizedAt);
  }
  if (!sample.size) return undefined;
  // Overlap connects the API's bounded recent lists. Without overlap, we can't
  // tell how many rounds finalized between reads, even from their round IDs.
  const lastSample = new Set(sample.keys());
  const connected = previous && [...lastSample].some((round) => previous.lastSample.has(round));
  const coverageFrom = connected ? previous.coverageFrom : Math.min(...sample.values());
  const start = checkedAt - PACE_WINDOW_MS;
  const rounds = new Map(connected ? previous.rounds : undefined);
  for (const [round, at] of sample) rounds.set(round, at);
  for (const [round, at] of rounds) if (at <= start) rounds.delete(round);
  return { coverageFrom, lastSample, rounds, rate: coverageFrom <= start ? rounds.size / (PACE_WINDOW_MS / 1000) : undefined };
}

export function updateBeaconView(previous: BeaconView, beacon: Beacon | null, now: number): BeaconView {
  if (!beacon) return { ...previous, now, failedSince: previous.failedSince ?? now };
  if (!beacon.configured) return { ...previous, now, issue: "unconfigured", failedSince: undefined, pace: undefined };

  const serverTime = Date.parse(beacon.checkedAt ?? "");
  const checkedAt = Number.isFinite(serverTime) ? serverTime : now;
  const last = previous.lastVerified;
  const switched = last?.beacon.process && beacon.process && last.beacon.process !== beacon.process;
  // A delayed sample can't replace either a newer verdict or a newer proof.
  if ((previous.checkedAt !== undefined && checkedAt <= previous.checkedAt)
    || (!switched && beacon.latest && last && beacon.latest.round < last.beacon.latest.round)) {
    return { ...previous, now };
  }

  const view: BeaconView = {
    ...previous, now, checkedAt, failedSince: undefined,
    lastOutage: beacon.lastOutage ?? (switched ? undefined : previous.lastOutage),
  };
  if (!beacon.latest || beacon.proofValid !== true) {
    return { ...view, issue: beacon.latest && beacon.proofValid === false ? "proof" : "awaiting", pace: undefined };
  }

  const latest = beacon.latest;
  const at = latest.finalizedAt && latest.finalizedAt <= checkedAt
    ? latest.finalizedAt
    : !switched && latest.round === last?.beacon.latest.round ? last.at : checkedAt;
  return {
    ...view,
    issue: undefined,
    lastVerified: { beacon: { ...beacon, latest }, at, checkedAt, receivedAt: now },
    pace: observedPace(switched ? undefined : previous.pace, [...(beacon.recent ?? []), latest], checkedAt),
  };
}

export function verifiedRoundAge(view: BeaconView): number {
  const round = view.lastVerified;
  return round ? Math.max(0, round.checkedAt - round.at + view.now - round.receivedAt) : 0;
}

export function beaconViewStatus(view: BeaconView): string {
  if (view.failedSince !== undefined) {
    return view.now - view.failedSince >= UNREACHABLE_MS ? "Beacon unreachable" : "Retrying beacon";
  }
  if (view.issue === "proof") return "Round proof failed";
  if (view.issue === "unconfigured") return "Beacon not configured";
  if (view.issue === "awaiting") return "Awaiting a verified round";
  if (!view.lastVerified) return "Checking beacon";
  return verifiedRoundAge(view) >= ROUND_STALE_MS ? "Waiting for a new round" : "Round verified";
}
