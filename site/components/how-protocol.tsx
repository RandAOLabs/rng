"use client";

import { useState } from "react";
import { useLivePoll } from "../hooks/use-live-poll";
import { SiteFooter, SiteHeader } from "./site-header";

type Status = {
  network: string; round: number; threshold: number; committeeSize: number;
  price: number; nativeVerification: boolean; verificationMode?: string; verified: boolean; value: string;
};

const surfaces = [
  ["01", "Local", "Live", "derive", "Free"],
  ["02", "Fast", "Live · on demand", "verify-bls", null],
  ["03", "Beacon", "Live · 2/s", "beacon", "Free to read"],
  ["04", "Any-Honest", "Live", "verify-reveal + verify-crack", "Per request"],
  ["05", "Proof", "Live", "verify", "Free"],
] as const;

export function HowProtocol() {
  const [status, setStatus] = useState<Status | null>(null);

  useLivePoll(async () => {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (response.ok) setStatus(await response.json() as Status);
    } catch { /* The device map remains useful offline. */ }
  });

  const device = status ? (status.nativeVerification ? "~rng@1.0" : status.verificationMode ?? "—") : "—";

  return (
    <main className="shell compact-page">
      <SiteHeader active="how" />
      <section className="page-titlebar container"><div><h1>How the RNG protocol works</h1></div><p>The library and beacon processes handle delivery. <code>~rng@1.0</code> handles deterministic cryptography.</p></section>
      <section className="how-board container">
        <div className="how-surface-table">
          <div className="table-head"><span>#</span><span>Surface</span><span>Status</span><span>Device operation</span><span>Cost</span></div>
          {surfaces.map(([index, name, state, operation, cost]) => (
            <div className="table-row" key={name}>
              <span>{index}</span><b>{name}</b><span className="surface-status">{state}</span>
              <code><small>Operation</small>/{operation}</code>
              <span><small>Cost</small>{cost ?? (status ? `${status.price} RNG` : "—")}</span>
            </div>
          ))}
        </div>
        <div className="how-lower">
          <div className="flow-panel">
            <p className="board-label">Fast request</p>
            <div className="flow-line"><span>Request lock</span><i>→</i><span>2/3 BLS</span><i>→</i><span>~rng@1.0</span><i>→</i><span>Value</span></div>
            <p>Any-Honest swaps the committee signature for commit, reveal, crack and combine.</p>
          </div>
          <dl className="compact-live" id="live">
            <div><dt>Network</dt><dd>{status?.network ?? "—"}</dd></div>
            <div><dt>Fast round</dt><dd>{status?.round ? status.round.toLocaleString("en-US") : "—"}</dd></div>
            <div><dt>Threshold</dt><dd>{status ? `${status.threshold}/${status.committeeSize}` : "—"}</dd></div>
            <div><dt>Verification</dt><dd>{device}</dd></div>
            <div className="wide"><dt>Proof</dt><dd className={status?.verified ? "pass" : "wait"}>{status ? (status.verified ? "Pass" : "Waiting") : "—"}</dd></div>
            <div className="value"><dt>Value</dt><dd>{status?.value ?? "—"}</dd></div>
          </dl>
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}
