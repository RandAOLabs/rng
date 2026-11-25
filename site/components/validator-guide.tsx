"use client";

import { useState } from "react";
import { useLivePoll } from "../hooks/use-live-poll";
import { beaconHealth, type BeaconHealthInput } from "./health-banner";
import { Section, Stat, Stats } from "./page-section";

type Validator = { address: string; ready?: boolean; suspended?: boolean; exiting?: boolean; overdue?: boolean; bond?: number; faults?: number };
type Params = {
  stake?: number; slash?: number; maxActive?: number; maxValidators?: number; minCommits?: number;
  commitWindowMs?: number; targetIntervalMs?: number;
  roundPrice?: number; requestPrice?: number; heartbeat?: number;
};
type Beacon = BeaconHealthInput & {
  configured?: boolean; process?: string; validators?: Validator[]; params?: Params;
  priceSchedule?: { round?: number; request?: number; crackBounty?: number };
};

// Heartbeat pay per validator: every round pays `roundPrice`, split across the
// active set. Requests add (requestPrice - 1) / active each (1 goes to the treasury).
export function estimateEarnings(roundPrice: number, roundsPerSecond: number, active: number) {
  const n = Math.max(1, active);
  const perSecond = (roundPrice * roundsPerSecond) / n;
  return { perSecond, perDay: perSecond * 86_400, perRound: roundPrice / n };
}

// Every figure on this page comes from the live beacon; until it answers, "—".
const fmt = (x?: number, digits = 0) => x === undefined || !Number.isFinite(x) ? "—" : x.toLocaleString("en-US", { maximumFractionDigits: digits });
const duration = (ms: number) => ms >= 3_600_000 ? `${fmt(ms / 3_600_000, 1)} h` : ms >= 60_000 ? `${fmt(ms / 60_000, 1)} min` : `${fmt(ms / 1000, 1)} s`;
const rng = (x?: number) => x === undefined ? "—" : `${fmt(x)} RNG`;

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };
  return (
    <div className="command">
      <pre>{text}</pre>
      <button type="button" onClick={copy} className="copy-button">{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

export function ValidatorGuide() {
  const [beacon, setBeacon] = useState<Beacon>();
  const [error, setError] = useState("");

  useLivePoll(async () => {
    try {
      const response = await fetch("/api/anyhonest", { cache: "no-store" });
      const body = await response.json() as Beacon & { error?: string };
      if (!response.ok) { setError(body.error ?? `HTTP ${response.status}`); return; }
      setBeacon(body); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Beacon unavailable"); }
  }, 10_000);

  const live = beacon?.configured ? beacon : undefined;
  const p: Params = live?.params ?? {};
  const roundPrice = live?.priceSchedule?.round ?? p.roundPrice;
  const requestPrice = live?.priceSchedule?.request ?? p.requestPrice;
  const crackBounty = live?.priceSchedule?.crackBounty;
  const validators = live?.validators ?? [];
  const active = validators.filter((v) => v.ready !== false && !v.suspended && !v.exiting && !v.overdue).length;
  const health = live ? beaconHealth(live) : undefined;
  const rate = p.targetIntervalMs ? 1000 / p.targetIntervalMs : undefined;
  const earn = (n?: number) => {
    if (!live || roundPrice === undefined || rate === undefined || n === undefined || p.stake === undefined) return "—";
    const e = estimateEarnings(roundPrice, rate, n);
    return `≈ ${fmt(e.perDay)} RNG/day · bond repaid in ${duration((p.stake / e.perSecond) * 1000)}`;
  };
  const stakeUnits = p.stake === undefined ? "<stake>" : `${p.stake}000000`;

  return (
    <div className="container pb-24">
      <section className="page-intro">
        <h1>Become a validator</h1>
        <p>Bond RNG and run a validator. One honest validator keeps a round unpredictable.</p>
      </section>

      <Section title="Live beacon">
        {error && <p className="status-line" role="status">Beacon unreachable</p>}
        {beacon && !beacon.configured && <p>The beacon is not deployed on this network yet.</p>}
        <Stats cols={6}>
          <Stat label="Registered" value={live ? fmt(validators.length) : "—"} />
          <Stat label="Active / cap" value={live ? `${fmt(active)} / ${fmt(p.maxActive)}` : "—"} />
          <Stat label="Health" value={health ? health.status : "—"} />
          <Stat label="Bond" value={rng(p.stake)} />
          <Stat label="Slash per miss" value={rng(p.slash)} />
          <Stat label="Round price" value={rng(roundPrice)} />
        </Stats>
        {health && health.status !== "ok" && <p>{health.message}</p>}
      </Section>

      <Section title="Who can validate">
        <ul>
          <li>Anyone holding at least {rng(p.stake)} for the bond.</li>
          <li>A machine with Node 22 and a durable disk for the wallet and round secrets. Losing secrets costs a slash per open round.</li>
          <li>A round trip to the scheduler under {p.commitWindowMs === undefined ? "—" : fmt(p.commitWindowMs / 2)} ms (half the commit window). The client refuses to mark itself ready until it measures this.</li>
        </ul>
        <p>The registry holds up to {fmt(p.maxValidators)} validators. Each round uses at most {fmt(p.maxActive)}, ranked by bond (counted up to {p.stake === undefined ? "—" : rng(4 * p.stake)}), then by how long they have been registered.</p>
      </Section>

      <Section title="Two ways to run">
        <div className="cards two">
          <div className="card">
            <p className="card-title">JS validator (recommended)</p>
            <p>One Node script, <code>validator/anyhonest-validator.mjs</code>. Commits are computed locally; reveals are verified by the beacon&apos;s node, so you do not need HyperBEAM.</p>
          </div>
          <div className="card">
            <p className="card-title">HyperBEAM node</p>
            <p>Build the HyperBEAM fork with the <code>rng-validator@1.0</code> device (started by the <code>on.start</code> hook) and <code>rng@1.0</code> (blst NIF). Same bond and rules; more work to set up.</p>
          </div>
        </div>
      </Section>

      <Section title="Steps">
        <p>The config file is JSON: <code>{"{ beacon, hbNode, dataDir }"}</code>. Exact flags may change; see the repo README.</p>
        <ol>
          <li><p>Create the validator wallet. It prints your address.</p><Command text="node validator/anyhonest-validator.mjs init validator.json" /></li>
          <li><p>Buy at least {rng(p.stake)} and send it to that address. Buy it on the <a href="https://trade.paralithmarkets.com/orderbook" target="_blank" rel="noreferrer">Paralith RNG/PUSD orderbook</a>. RNG has a fixed supply and no faucet.</p></li>
          <li><p>Bond: transfer the stake to the beacon with the <code>X-Bond</code> tag. A first bond below {rng(p.stake)} is refunded. The validator&apos;s bond command sends this for you (see repo README for flags).</p><Command text={`Transfer { Recipient = <beacon>, Quantity = ${stakeUnits}, X-Bond = "true" }`} /></li>
          <li><p>Run it. The validator sends <code>Ready</code> once its connection is healthy and then works every round it is in the active set.</p><Command text="node validator/anyhonest-validator.mjs run validator.json" /></li>
        </ol>
        <p>To leave, exit and then finalize once the exit round has passed. Finalizing refunds your bond.</p>
        <Command text={"node validator/anyhonest-validator.mjs exit validator.json\nnode validator/anyhonest-validator.mjs finalize-exit validator.json"} />
      </Section>

      <Section title="Slashing and rejoining">
        <ul>
          <li>Every missed commit or reveal costs {rng(p.slash)} of your bond, paid to the treasury, and suspends you.</li>
          <li>A withheld reveal is cracked by others; the {rng(crackBounty)} crack bounty is taken from your bond too.</li>
          <li>There is no cooldown. A suspended validator rejoins as soon as it can answer again. One you paused or set to exit stays out.</li>
          <li>To rejoin, your bond plus earnings must cover the full {rng(p.stake)} stake again. Top up before you send <code>Ready</code>; the validator does this check itself.</li>
          <li>Governance can remove a validator, but it always refunds the full bond. It cannot take bonds.</li>
        </ul>
      </Section>

      <Section title="Expected earnings">
        <p>Each round pays {rng(roundPrice)} from the reserve, split across the active set, at about {fmt(rate, 1)} rounds per second. Each request adds {requestPrice === undefined ? "—" : rng(requestPrice - 1)} split across the round&apos;s contributors.</p>
        <Stats cols={2}>
          <Stat label={`If you join now (${live ? fmt(active + 1) : "—"} active)`} value={earn(live ? active + 1 : undefined)} />
          <Stat label={`With a full set (${fmt(p.maxActive)} active)`} value={earn(p.maxActive)} />
        </Stats>
        <p>These are heartbeat estimates, not promises. Pay falls as more validators join. When the reserve runs out, the beacon only runs rounds for paid requests and pay drops to the request share.</p>
      </Section>

      <Section title="Risks">
        <ul>
          <li>Downtime and slow links cost {rng(p.slash)} per missed duty.</li>
          <li>Lost round secrets mean a slash for every round you had open.</li>
          <li>A lost wallet means a lost bond. Nobody can recover it for you.</li>
          <li>The RNG DAO can change parameters such as stake, slash and prices, within fixed hard bounds.</li>
          <li>RNG price risk: your bond and earnings are in RNG.</li>
        </ul>
      </Section>
    </div>
  );
}
