"use client";

import { useState } from "react";
import { useLivePoll } from "../hooks/use-live-poll";
import { connectWallet } from "../lib/wallet";
import {
  describeAction, duration, ownersLabel, percent, tally, tokens, yapUrl,
  type DaoInfo, type DaoProposal, type DaoStake, type GovOwners,
} from "../app/api/dao/model";
import { Section, Stat, Stats } from "./page-section";
import { SiteFooter, SiteHeader } from "./site-header";

type DaoStatus = { configured: boolean; status?: string; process?: string; node?: string; beacon?: string;
  info?: DaoInfo; proposals?: DaoProposal[] };
// beaconinfo via /api/anyhonest. The v3 governance fields are absent on a v2 beacon.
type Beacon = { configured: boolean; process?: string; round?: number; unit?: number;
  foundationReserveAtoms?: string; treasuryAtoms?: string; mode?: string; paused?: boolean;
  gov?: GovOwners; successor?: string; successorAck?: boolean; features?: string[] };

const short = (a?: string) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
const when = (ms?: number) => ms ? new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—";
const rng = (amount: string) => amount === "—" ? amount : `${amount} RNG`;

// A failed read returns null so the page keeps its last good state.
async function readJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.ok ? await response.json() as T : null;
  } catch { return null; }
}

export function DaoConsole() {
  const [dao, setDao] = useState<DaoStatus>();
  const [beacon, setBeacon] = useState<Beacon>();
  const [daoDown, setDaoDown] = useState(false);
  const [beaconDown, setBeaconDown] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [stake, setStake] = useState<DaoStake | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const [nextDao, nextBeacon] = await Promise.all([readJson<DaoStatus>("/api/dao"), readJson<Beacon>("/api/anyhonest")]);
    if (nextDao) setDao(nextDao);
    if (nextBeacon) setBeacon(nextBeacon);
    setDaoDown(!nextDao);
    setBeaconDown(!nextBeacon);
  }

  useLivePoll(refresh, 5_000);

  async function action(label: string, run: () => Promise<void>) {
    setBusy(label); setError(null);
    try { await run(); await refresh(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { setBusy(null); }
  }

  const connect = () => action("Connecting", async () => {
    const next = await connectWallet();
    setAddress(next);
    const response = await fetch(`/api/dao?address=${encodeURIComponent(next)}`, { cache: "no-store" });
    const body = await response.json() as { stake?: DaoStake; error?: string };
    if (!response.ok) throw new Error(body.error || "stake unavailable");
    setStake(body.stake ?? null);
  });

  const info = dao?.info;
  const proposals = dao?.proposals ?? [];
  const denom = info?.Denomination ?? 6;
  const unitDigits = Math.round(Math.log10(beacon?.unit ?? 1_000_000));
  const v3 = beacon?.features?.includes("gov") ?? false;
  const beaconPid = dao?.beacon || beacon?.process || "";
  const yap = dao?.process && dao.node ? yapUrl(dao.process, dao.node) : null;

  return (
    <main className="shell">
      <SiteHeader active="dao" />
      <div className="container pb-24">
        <section className="page-intro">
          <h1>RNG DAO</h1>
          <p>RNG holders govern the beacon by staking on YapDAO.</p>
          {yap && <a className="button primary" href={yap} target="_blank" rel="noreferrer">Vote on yapdao.com</a>}
        </section>

        <Section title="Beacon governance">
          {beaconDown && <p className="status-line" role="status">Beacon unreachable</p>}
          {beacon && !beacon.configured && <p>The beacon is not deployed on this network yet.</p>}
          {beacon?.configured && !v3 && <p>This beacon predates DAO governance.</p>}
          <Stats cols={6}>
            <Stat label="Owners" value={v3 ? ownersLabel(beacon?.gov) : "—"} />
            <Stat label="DAO" value={beacon?.gov?.dao ? short(beacon.gov.dao) : "—"} />
            <Stat label="Mode" value={beacon?.paused ? "Paused" : beacon?.mode ?? "—"} />
            <Stat label="Reserve" value={rng(tokens(beacon?.foundationReserveAtoms, unitDigits))} />
            <Stat label="Treasury" value={rng(tokens(beacon?.treasuryAtoms, unitDigits))} />
            <Stat label="Successor" value={!beacon?.configured ? "—" : beacon.successor ? `${short(beacon.successor)}${beacon.successorAck ? " (acked)" : ""}` : "None"} />
          </Stats>
        </Section>

        <Section title="The DAO">
          {daoDown && <p className="status-line" role="status">DAO unreachable</p>}
          {dao && !dao.configured && <p>{dao.status === "not-stake-dao" ? "The configured DAO process is not a stake-dao/1 DAO." : "The RNG DAO is not deployed on this network yet."}</p>}
          <Stats cols={6}>
            <Stat label="Staked" value={info ? `${tokens(info.TotalStaked, denom)} ${info.Ticker}` : "—"} />
            <Stat label="Stakers" value={info?.Stakers ?? "—"} />
            <Stat label="Open proposals" value={info ? `${info.OpenProposals} / ${info.MaxActiveProposals}` : "—"} />
            <Stat label="To propose" value={info ? `${tokens(info.ProposalRequirement ?? info.ProposalThreshold, denom)} + ${tokens(info.ProposalDeposit, denom)} deposit` : "—"} />
            <Stat label="Voting period" value={info ? duration(info.VotingPeriod) : "—"} />
            <Stat label="Unstake delay" value={info ? duration(info.UnstakeDelay) : "—"} />
          </Stats>
          {info && <p>Quorum {percent(info.QuorumBps)} of staked RNG. Passes above {percent(info.PassBps)} yes; vetoed above {percent(info.VetoBps)} veto.</p>}
          {address && <p>Your stake ({short(address)}): {tokens(stake?.active ?? "0", denom)} active, {tokens(stake?.cooling ?? "0", denom)} cooling{stake?.releaseAt ? `, withdrawable ${when(stake.releaseAt)}` : ""}.</p>}
          {!address && dao?.configured && <div><button className="button" onClick={() => void connect()} disabled={Boolean(busy)}>Show my stake</button></div>}
        </Section>

        <Section title="Proposals">
          {!dao ? <p>—</p> : proposals.length === 0 && <p>No proposals yet.</p>}
          {proposals.length > 0 && <div className="cards">{proposals.slice(0, 20).map((p) => {
            const t = tally(p);
            const act = describeAction(p.action, beaconPid);
            return (
              <article key={p.id} className="card">
                <p className="card-meta">#{p.id} · {p.status}{p.status === "active" ? ` · ends ${when(p.endsAt)} · would be ${t.outcome}` : ""}</p>
                <p className="card-title">{p.title}</p>
                <p className="card-meta">Yes {tokens(p.yes, denom)} · No {tokens(p.no, denom)} · Veto {tokens(p.veto, denom)} · Abstain {tokens(p.abstain, denom)} · quorum {t.quorumMet ? "met" : `${tokens(p.quorum, denom)} needed`} · {p.voters} voters</p>
                {act && <p className="card-meta"><code>{act.name}</code> {act.args} → {act.toBeacon ? "beacon" : short(p.action?.process)}{act.executed ? " · executed" : ""}</p>}
                {yap && p.status === "active" && <p><a href={yap} target="_blank" rel="noreferrer">Vote on YapDAO</a></p>}
              </article>);
          })}</div>}
        </Section>
        {busy && <p className="notice" role="status">{busy}…</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <SiteFooter />
    </main>
  );
}
