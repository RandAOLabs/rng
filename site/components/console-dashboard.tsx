"use client";

import { useRef, useState, type CSSProperties } from "react";
import { useLivePoll } from "../hooks/use-live-poll";
import { beaconViewStatus, updateBeaconView, verifiedRoundAge, type Beacon, type BeaconView, type InFlight, type Recent, type Validator } from "../lib/beacon-panel";
import { SiteFooter, SiteHeader } from "./site-header";

type Pulse = { round: number; value: string; ms?: number };
type Cell = "empty" | "locked" | "lit" | "crack";
// Three fixed slots, top to bottom: NEXT (the newest round in flight), CURRENT
// (the oldest round in flight) and RESOLVED (the last completed round). Rounds
// overlap, so any in flight between NEXT and CURRENT are not shown. A new round
// fades in as NEXT while the others step down one slot; a round that leaves
// the slots slides out below and fades (`out` is when it left).
type Track = { round: number; slot: number; out?: number; commit: Cell[]; reveal: Cell[]; done: boolean; value?: string };
const SLOTS = ["Next", "Current", "Resolved"];
const ROWS = SLOTS.length;
// The CSS slide takes 300 ms; drop the row once it is out of view.
const OUT_MS = 400;
const EMPTY_VIEW: BeaconView = { now: 0 };
const utcTime = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", timeStyle: "medium" });

const STAGES = ["Commit", "Reveal", "Combine", "Verify"];

// Process state serialises sets as either address lists or address-keyed maps.
const members = (set: unknown) => new Set(Array.isArray(set) ? set.map(String) : Object.keys(set ?? {}));

const toPulse = (r: Recent): Pulse => ({
  round: r.round, value: r.value, ms: r.opened && r.finalizedAt ? r.finalizedAt - r.opened : undefined,
});

function toTracks(beacon: Beacon, validators: Validator[]): Track[] {
  const latest = beacon.latest;
  const inFlight = [...(beacon.revealing ?? []), ...(beacon.open ? [beacon.open] : [])]
    .filter((r) => !latest || r.round > latest.round)
    .sort((x, y) => x.round - y.round);
  // A lone round in flight is CURRENT, so each round only ever steps down.
  const shown: [InFlight, number][] = inFlight.length > 1 ? [[inFlight[inFlight.length - 1], 0], [inFlight[0], 1]] : inFlight.map((r) => [r, 1]);
  const tracks: Track[] = shown.map(([r, slot]) => {
    const committed = members(r.committed), revealed = members(r.revealed);
    return {
      round: r.round, slot, done: false,
      commit: validators.map((v) => committed.has(v.address) ? "locked" : "empty"),
      reveal: validators.map((v) => revealed.has(v.address) ? "lit" : "empty"),
    };
  });
  if (latest) {
    tracks.push({
      round: latest.round, slot: ROWS - 1, done: true, value: latest.value,
      commit: validators.map((v) => latest.commits[v.address] ? "locked" : "empty"),
      reveal: validators.map((v) => latest.outputs[v.address]?.via === "crack" ? "crack" : latest.outputs[v.address] ? "lit" : "empty"),
    });
  }
  return tracks;
}

// A text gauge for the pace against the 2 rounds/s target:
// `[··|··●··|··] on pace`. Each side spans 1 round/s; the bars mark ±10%.
export function paceScale(rate: number, target = 2): string {
  const half = 5;
  const offset = Math.max(-half, Math.min(half, Math.round(((rate - target) / target) * half * 2)));
  const cells = Array.from({ length: half * 2 + 1 }, (_, i) => (i === half + offset ? "●" : "·"));
  const bar = `[${cells.slice(0, half - 1).join("")}|${cells.slice(half - 1, half + 2).join("")}|${cells.slice(half + 2).join("")}]`;
  const label = rate < target * 0.9 ? "slow" : rate > target * 1.1 ? "fast" : "on pace";
  return `${bar} ${label.padEnd(7)}`;
}

// Fixed width so the rate, gauge and label never shift as the numbers change.
export function paceText(rate?: number): string {
  const width = paceScale(2).length + 7;
  if (rate === undefined) return "Measuring pace".padEnd(width);
  const shown = Math.min(rate, 99.9).toFixed(1).padStart(4);
  return `${shown}/s ${paceScale(rate)}`;
}

function RoundTrack({ track }: { track: Track }) {
  const committed = track.commit.some((c) => c !== "empty");
  const revealed = track.done || track.reveal.every((c) => c !== "empty");
  const state = [
    committed ? "done" : "active",
    revealed ? "done" : committed ? "active" : "",
    track.done ? "done" : "",
    track.done ? "done" : "",
  ];
  return (
    <div className={`track${track.done ? "" : " live"}${track.out ? " out" : ""}`} style={{ "--slot": track.slot } as CSSProperties}>
      <div className="track-tag"><b>#{track.round}</b><span>{SLOTS[Math.min(track.slot, ROWS - 1)]}</span></div>
      <div className={`stage-box ${state[0]}`}>{track.commit.map((c, i) => <span key={i} className={`cell ${c}`} />)}</div>
      <div className={`stage-box ${state[1]}`}>{track.reveal.map((c, i) => <span key={i} className={`cell ${c}`} />)}</div>
      <div className={`stage-box ${state[2]}`}>{track.done ? <span className="merge" /> : track.reveal.map((_, i) => <span key={i} className="cell empty" />)}</div>
      <div className={`stage-box ${state[3]}`}>{track.done ? <span className="verdict"><b>Pass</b><code>{track.value?.slice(0, 10)}</code></span> : <span className="verdict pending">—</span>}</div>
    </div>
  );
}

function BeaconPipeline({ validators, tracks, total, rate, paused }: { validators: Validator[]; tracks: Track[]; total?: number; rate?: number; paused: boolean }) {
  return (
    <div className="pipe">
      <div className="pipe-total">
        <div><span>Last verified round</span><b>{total?.toLocaleString("en-US") ?? "—"}</b></div>
        <small className="pipe-pace"><span>Observed pace · 30s</span><b>{paused ? "Pace paused" : paceText(rate).trimEnd()}</b></small>
      </div>
      <div className="pipe-head">
        <div><span>Validators</span><b>{validators.length || "—"}</b></div>
        {STAGES.map((stage) => <div key={stage}><span>{stage}</span></div>)}
      </div>
      <div className="tracks">{tracks.map((t) => <RoundTrack key={t.round} track={t} />)}</div>
    </div>
  );
}

export function ConsoleDashboard() {
  const [feed, setFeed] = useState<Pulse[]>([]);
  const [validators, setValidators] = useState<Validator[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);

  const current = useRef(EMPTY_VIEW);
  const [view, setView] = useState(EMPTY_VIEW);

  // One bounded read at a time. The API's recent list fills in rounds between reads.
  useLivePoll(async () => {
    let body: Beacon | null = null;
    try {
      const response = await fetch("/api/anyhonest", { cache: "no-store", signal: AbortSignal.timeout(4_000) });
      if (response.ok) body = await response.json() as Beacon;
    } catch { /* Retain the last verified snapshot while retrying. */ }

    const state = current.current;
    const updated = updateBeaconView(state, body, Date.now());
    current.current = updated;
    setView(updated);
    const snapshot = updated.lastVerified;
    if (!snapshot || snapshot === state.lastVerified) return;

    const beacon = snapshot.beacon;
    // Validators that left, paused or were suspended cannot join new rounds.
    const active = (beacon.validators ?? []).filter((v) => !v.exiting && !v.suspended && v.ready !== false);
    const processChanged = state.lastVerified?.beacon.process !== beacon.process;
    setValidators(active);
    const next = toTracks(beacon, active);
    setTracks((prev) => {
      const shown = new Set(next.map((track) => track.round));
      const leaving = (processChanged ? [] : prev)
        .filter((track) => !shown.has(track.round) && (!track.out || updated.now - track.out < OUT_MS))
        .map((track) => track.out ? track : { ...track, slot: ROWS, out: updated.now });
      return [...next, ...leaving];
    });
    setFeed((prev) => {
      const pulses = new Map((processChanged ? [] : prev).map((pulse) => [pulse.round, pulse]));
      for (const round of [...(beacon.recent ?? []), beacon.latest]) {
        pulses.set(round.round, toPulse(round));
      }
      return [...pulses.values()].sort((a, b) => b.round - a.round).slice(0, 3);
    });
  }, 300);

  const status = beaconViewStatus(view);
  const verified = view.lastVerified;
  const stale = status !== "Round verified";
  const lastGap = view.lastOutage && (view.checkedAt ?? view.now) - view.lastOutage.at < 5 * 60_000 ? view.lastOutage : undefined;

  return (
    <main className="shell home-page">
      <SiteHeader />

      <section className="home-simple container">
        <div className="home-message">
          <h1>Verifiable randomness</h1>
          <p>Inspect live beacon rounds or generate a value from a seed.</p>
          <a className="button primary" href="/try">Open the RNG console</a>
        </div>

        <section className="rng-visual" aria-label="Live Any-Honest beacon" data-stale={stale}>
          <BeaconPipeline validators={validators} tracks={tracks} total={verified?.beacon.latest.round} rate={view.pace?.rate} paused={view.failedSince !== undefined || view.issue === "proof"} />
          <ul className="beacon-feed" aria-label="Recent finalized rounds reported by the beacon">
            {feed.map((p, i) => <li key={p.round} className={i === 0 ? "fresh" : undefined}><span>#{p.round}</span><code>{p.value.slice(0, 24)}</code><b>{p.ms ? `${p.ms}ms` : ""}</b></li>)}
          </ul>
          <div className="home-status">
            <div className="home-status-copy">
              <p role="status"><span className={stale ? "signal" : "signal on"} aria-hidden="true" /><strong>{status}</strong></p>
              {verified && <small>{verified.at === verified.beacon.latest.finalizedAt ? "Finalized" : "First verified"} <time dateTime={new Date(verified.at).toISOString()}>{utcTime.format(verified.at)} UTC</time> · {Math.floor(verifiedRoundAge(view) / 1000)}s ago</small>}
              {view.issue === "proof" && view.failedSince !== undefined && <small>Latest proof check failed</small>}
              {lastGap && <small>Last reported gap: {Math.round(lastGap.gapMs / 1000)}s at <time dateTime={new Date(lastGap.at).toISOString()}>{utcTime.format(lastGap.at)} UTC</time></small>}
            </div>
            <a href="/how">How the beacon works →</a>
          </div>
        </section>
      </section>

      <SiteFooter />
    </main>
  );
}
