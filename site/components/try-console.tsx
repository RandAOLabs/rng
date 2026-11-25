"use client";

import { useEffect, useState } from "react";
import { useLivePoll } from "../hooks/use-live-poll";
import { findRequest, payAndRequestTags, type RequestRecord } from "../../lib/js/fair-client";
import { fastRequestValue } from "../../lib/js/derive";
import { connectWallet, hasWallet, sendMessage } from "../lib/wallet";
import { RNG_MARKET_URL } from "../lib/market";
import { SiteFooter, SiteHeader } from "./site-header";

type Mode = "local" | "threshold" | "beacon" | "anyhonest" | "proof";
type Status = {
  node: string; network: string; beacon: string; token: string; round: number; price: number;
  unit: number; threshold: number; committeeSize: number; nativeVerification: boolean; verificationMode?: string | null;
  groupKey: string; signature: string; message: string; value: string; verified: boolean;
  derivation?: string | null;
};
type Account = { address: string; tokenBalance: number; beaconBalance: number; price: number; unit: number };
type Draw = { requestId: string; round: number; value?: string; verified?: boolean };
// v3 adds process/token/price/mode/features and per-request round records; a v2 beacon omits them.
type AnyHonestStatus = { node?: string; configured: boolean; process?: string; token?: string; price?: number;
  mode?: string; features?: string[]; requestRecords?: RequestRecord[]; round?: number; proofValid?: boolean;
  foundationReserveAtoms?: string; treasuryAtoms?: string; unit?: number;
  activeSubscriptions?: number; validators?: Array<{ suspended?: boolean; exiting?: boolean }>;
  latest?: { value?: string }; priceSchedule?: { round?: number; request?: number; crackBounty?: number } };

const modes: Array<{ key: Mode; title: string }> = [
  { key: "local", title: "Local seed" },
  { key: "threshold", title: "Fast request" },
  { key: "beacon", title: "Public beacon" },
  { key: "anyhonest", title: "Any-Honest" },
  { key: "proof", title: "Verify a round" },
];

// Prices and counts render as "—" until the live process has answered.
const rngAmount = (x?: number) => x === undefined ? "—" : `${x} RNG`;

export function TryConsole() {
  const [mode, setMode] = useState<Mode>("beacon");
  const [status, setStatus] = useState<Status | null>(null);
  const [anyHonest, setAnyHonest] = useState<AnyHonestStatus>({ configured: false });
  const [anyHonestLoaded, setAnyHonestLoaded] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [seed, setSeed] = useState("loot-chest-42");
  const [derived, setDerived] = useState("");
  const [deriving, setDeriving] = useState(false);
  const [proofRound, setProofRound] = useState("");
  const [proof, setProof] = useState<Status | null>(null);
  const [proofBusy, setProofBusy] = useState(false);
  const [walletPresent, setWalletPresent] = useState<boolean | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draw, setDraw] = useState<Draw | null>(null);
  const [paid, setPaid] = useState<{ requestId: string; round?: number; value?: string; valid?: boolean } | null>(null);

  function chooseMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function refreshStatus(round?: number) {
    const response = await fetch(`/api/status${round ? `?round=${round}` : ""}`, { cache: "no-store" });
    const body = await response.json() as Status & { error?: string };
    if (!response.ok) throw new Error(body.error || "status unavailable");
    if (!round) setStatus(body);
    return body;
  }

  async function refreshAnyHonest() {
    const response = await fetch("/api/anyhonest", { cache: "no-store" });
    const body = await response.json() as AnyHonestStatus & { error?: string };
    if (!response.ok) throw new Error(body.error || "Any-Honest status unavailable");
    setAnyHonest(body);
    setAnyHonestLoaded(true);
    return body;
  }

  useLivePoll(() => Promise.all([refreshStatus(), refreshAnyHonest()]).then(() => setStatusError(null)).catch((problem) => setStatusError(problem instanceof Error ? problem.message : "status unavailable")));

  useEffect(() => {
    const wallet = window.setTimeout(() => setWalletPresent(hasWallet()), 0);
    return () => window.clearTimeout(wallet);
  }, []);

  async function derive() {
    setDeriving(true); setError(null);
    try {
      const response = await fetch("/api/derive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed, bytes: 32, counter: 0 }) });
      const body = await response.json() as { value?: string; error?: string };
      if (!response.ok) throw new Error(body.error || "derivation failed");
      setDerived(body.value ?? "");
    } catch (problem) { setError(problem instanceof Error ? problem.message : "derivation failed"); }
    finally { setDeriving(false); }
  }

  async function inspectProof() {
    setProofBusy(true); setError(null);
    try {
      const requested = proofRound.trim() === "" ? undefined : Number(proofRound);
      if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) throw new Error("round must be a positive integer");
      setProof(await refreshStatus(requested));
    } catch (problem) { setError(problem instanceof Error ? problem.message : "verification failed"); }
    finally { setProofBusy(false); }
  }

  async function refreshAccount(currentAddress = address) {
    if (!currentAddress) return null;
    const response = await fetch(`/api/account?address=${encodeURIComponent(currentAddress)}`, { cache: "no-store" });
    const body = await response.json() as Account & { error?: string };
    if (!response.ok) throw new Error(body.error || "account unavailable");
    setAccount(body);
    return body;
  }

  async function walletAction(label: string, action: () => Promise<void>) {
    setBusy(label); setError(null);
    try { await action(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { setBusy(null); }
  }

  function rejectError(reply: Record<string, unknown>) {
    if (typeof reply.error === "string") throw new Error(reply.error);
  }

  const onConnect = () => walletAction("Connecting wallet", async () => {
    const next = await connectWallet(); setAddress(next); await refreshAccount(next);
  });
  const onFund = () => walletAction("Funding Fast", async () => {
    if (!status || !address) throw new Error("connect a wallet first");
    rejectError((await sendMessage(status.node, status.token, { Action: "Transfer", Recipient: status.beacon, Quantity: String(status.price * 3 * status.unit), "X-For": address })).reply);
    await refreshAccount();
  });
  const onRequest = () => walletAction("Waiting for the Fast round", async () => {
    if (!status || !address) throw new Error("connect a wallet first");
    const requestId = `console-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    // Tier "beacon" is the fast tier's internal id, accepted by the old and the new process.
    const reply = (await sendMessage(status.node, status.beacon, { Action: "Request-Random", Tier: "beacon", "Request-Id": requestId })).reply;
    rejectError(reply);
    const round = Number(reply.round);
    if (!Number.isSafeInteger(round) || round < 1) throw new Error("the fast tier did not assign a round");
    setDraw({ requestId, round });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const nextProof = await refreshStatus(round);
        const value = await fastRequestValue(nextProof, address, requestId);
        setDraw({ requestId, round, value, verified: nextProof.verified });
        await Promise.all([refreshStatus(), refreshAccount()]);
        return;
      } catch { await new Promise((resolve) => window.setTimeout(resolve, 500)); }
    }
    throw new Error(`round ${round} did not finalize within 30 seconds`);
  });

  // One message: a token Transfer to the beacon with X-Request-Id credits and
  // requests in the same slot. A wallet's value is only in the round record.
  const onPayAndRequest = () => walletAction("Requesting", async () => {
    const beacon = anyHonest;
    if (!beacon.node || !beacon.process || !beacon.token || !beacon.unit) throw new Error("the beacon is not ready");
    if (!beacon.features?.includes("pay-and-request")) throw new Error("this beacon does not take one-message requests yet (beacon v3)");
    const who = address ?? await connectWallet();
    setAddress(who);
    const price = beacon.price ?? beacon.priceSchedule?.request ?? 4;
    const requestId = `console-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    setPaid({ requestId });
    rejectError((await sendMessage(beacon.node, beacon.token, payAndRequestTags(beacon.process, BigInt(price) * BigInt(beacon.unit), requestId))).reply);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const body = await refreshAnyHonest().catch(() => null);
      const found = body ? await findRequest(body.requestRecords, who, requestId) : null;
      if (found) { setPaid({ requestId, round: found.round, value: found.value, valid: found.valid }); return; }
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    throw new Error("no result within 60 seconds. If the beacon refused the request, the RNG stays in your beacon balance.");
  });

  const shownProof = proof ?? status;
  const fastPrice = status?.price;
  const unreachable = statusError ? <p className="status-line" role="status">Beacon unreachable</p> : null;
  const beaconState = anyHonest.configured ? "Live" : statusError ? "Unreachable" : anyHonestLoaded ? "Not deployed" : "—";
  const activeValidators = anyHonestLoaded ? anyHonest.validators?.filter((validator) => !validator.suspended && !validator.exiting).length : undefined;
  const reserve = anyHonest.foundationReserveAtoms && anyHonest.unit ? `${(BigInt(anyHonest.foundationReserveAtoms) / BigInt(anyHonest.unit)).toString()} RNG` : "—";
  const requestPrice = anyHonest.price ?? anyHonest.priceSchedule?.request;
  const proofDevice = shownProof ? (shownProof.nativeVerification ? "~rng@1.0" : shownProof.verificationMode ?? "—") : "—";

  return (
    <main className="shell try-page">
      <SiteHeader active="try" />
      <section className="container product-switcher" aria-label="RNG products">
        <label className="console-tool-picker">
          Console tool
          <select value={mode} disabled={walletPresent === null} onChange={event => chooseMode(event.target.value as Mode)}>
            {modes.map(item => <option key={item.key} value={item.key}>{item.title}</option>)}
          </select>
        </label>
        {modes.map(item => (
          <button key={item.key} type="button" disabled={walletPresent === null}
            className={mode === item.key ? "product-option selected" : "product-option"}
            onClick={() => chooseMode(item.key)} aria-pressed={mode === item.key}>{item.title}</button>
        ))}
      </section>

      <section className="try-workspace container"><div className="mode-workbench">
        {mode === "local" && <div className="workbench-grid">
          <div>
            <h2>Generate from a seed</h2>
            <p className="muted">Free and replay-safe. The sender can predict the result.</p>
            <label className="field"><span>Seed</span><input value={seed} onChange={(event) => setSeed(event.target.value)} maxLength={4096} /></label>
            <button className="button primary" onClick={derive} disabled={deriving || !seed}>{deriving ? "Generating…" : "Generate value"}</button>
          </div>
          <div className="terminal">
            <div className="terminal-bar"><span>stdout</span><span>~rng@1.0/derive</span></div>
            <div className="terminal-body"><p><span className="prompt">&gt;</span> bytes=32 counter=0</p><code className="big-output">{derived || "—"}</code></div>
          </div>
        </div>}

        {mode === "threshold" && <div>
          <h2>Fast random</h2>
          <p className="muted">2-of-3 threshold BLS on demand. Safe unless 2 of 3 operators collude.</p>
          <ol className="wallet-steps">
            <li className={address ? "done" : "active"}><span>1</span><div><strong>Connect Wander</strong><small>{address ?? "Not connected"}</small></div>
              <button className="button" onClick={onConnect} disabled={Boolean(address) || Boolean(busy)}>{address ? "Connected" : walletPresent ? "Connect" : "No wallet"}</button></li>
            <li className={(account?.tokenBalance ?? 0) >= ((status?.price ?? 3) * 3) ? "done" : address ? "active" : ""}><span>2</span><div><strong>Get RNG</strong><small>Wallet {account ? `${account.tokenBalance} RNG` : "—"}</small></div>
              <a className="button" href={RNG_MARKET_URL} target="_blank" rel="noreferrer">Buy RNG</a></li>
            <li className={(account?.beaconBalance ?? 0) >= (status?.price ?? 3) ? "done" : account ? "active" : ""}><span>3</span><div><strong>Fund Fast</strong><small>Credit {account ? `${account.beaconBalance} RNG` : "—"}</small></div>
              <button className="button" onClick={onFund} disabled={!account || account.tokenBalance < ((status?.price ?? 3) * 3) || Boolean(busy)}>{fastPrice === undefined ? "Fund" : `Fund ${fastPrice * 3} RNG`}</button></li>
            <li className={(account?.beaconBalance ?? 0) >= (status?.price ?? 3) ? "active" : ""}><span>4</span><div><strong>Request a value</strong><small>Costs {rngAmount(fastPrice)}</small></div>
              <button className="button primary" onClick={onRequest} disabled={!account || account.beaconBalance < (status?.price ?? 3) || Boolean(busy)}>Request</button></li>
          </ol>
          {walletPresent === false && <p className="notice">Wander not found. <a href="https://wander.app" target="_blank" rel="noreferrer">Install Wander</a></p>}
          {busy && <p className="notice" role="status">{busy}… Approve in Wander if asked.</p>}
          {draw && <output className="proof-output"><strong>{draw.value ? "Result" : `Waiting for round ${draw.round}`}</strong>{draw.value && <><span>{draw.verified ? "Proof verified" : "Proof unknown"}</span><code>{draw.value}</code><small>Round {draw.round} · request {draw.requestId}</small></>}</output>}
        </div>}

        {mode === "beacon" && <div className="workbench-grid">
          <div>
            <h2>Public beacon</h2>
            <p className="muted">Two Any-Honest rounds a second, prepaid by the RNG Foundation.</p>
            <div className="fact-stack">
              <div><span>Status</span><b>{beaconState}</b></div>
              <div><span>Source</span><b>Any-Honest</b></div>
              <div><span>Proof</span><b>{anyHonestLoaded ? (anyHonest.proofValid ? "Verified" : "Waiting") : "—"}</b></div>
            </div>
          </div>
          <div className="terminal">
            <div className="terminal-bar"><span>beacon.feed</span><span>{anyHonest.proofValid ? "pass" : "wait"}</span></div>
            <div className="terminal-body">
              <p>mode......... {anyHonest.mode ?? "—"}</p>
              <p>round........ {anyHonest.round ?? "—"}</p>
              <p>validators... {activeValidators ?? "—"}</p>
              <p>round-cost... {rngAmount(anyHonest.priceSchedule?.round)}</p>
              <p>reserve...... {reserve}</p>
              <code className="big-output">{anyHonest.latest?.value ?? "—"}</code>
            </div>
          </div>
        </div>}

        {mode === "anyhonest" && <div className="roadmap-workbench">
          <div>
            <h2>Any-Honest randomness</h2>
            <p className="muted">Safe if any one validator in the round is honest.</p>
            <p className="roadmap-status" role="status"><span className={anyHonest.proofValid ? "signal on" : "signal"} />{anyHonest.proofValid ? "Round verified" : "Awaiting a verified round"}</p>
          </div>
          <div className="protocol-steps">
            <div><span>01</span><b>Commit</b><p>Validators lock fresh puzzle contributions.</p></div>
            <div><span>02</span><b>Reveal</b><p>Secrets open only after the commit window closes.</p></div>
            <div><span>03</span><b>Crack</b><p>Treasury pays a {rngAmount(anyHonest.priceSchedule?.crackBounty)} verified-crack bounty.</p></div>
            <div><span>04</span><b>Combine</b><p>Every canonical output becomes one round value.</p></div>
          </div>
          <div className="request-block">
            <strong>Request one value</strong>
            <p>One signed message pays {rngAmount(requestPrice)} for a value from the next round. Buy RNG on the <a href={RNG_MARKET_URL} target="_blank" rel="noreferrer">RNG/PUSD orderbook</a>.</p>
            <button className="button primary" onClick={onPayAndRequest} disabled={Boolean(busy) || !anyHonest.configured || !anyHonest.features?.includes("pay-and-request")}>{busy === "Requesting" ? "Waiting for the round…" : address ? "Pay and request" : "Connect and request"}</button>
            {!anyHonest.features?.includes("pay-and-request") && anyHonest.configured && <p>Available once beacon v3 is live.</p>}
            {paid && <output className="proof-output"><strong>{paid.value ? `Round ${paid.round}` : "Waiting for your round"}</strong>{paid.value && <><span>{paid.valid ? "Value recomputed from the round: match" : "Value does not match the round"}</span><code>{paid.value}</code></>}<small>Request {paid.requestId}</small></output>}
          </div>
          <div className="device-paths"><code>~rng@1.0/generator</code><code>~rng@1.0/verify-reveal</code><code>~rng@1.0/verify-crack</code><code>~rng@1.0/derive</code></div>
        </div>}

        {mode === "proof" && <div className="workbench-grid">
          <div>
            <h2>Verify a Fast round</h2>
            <p className="muted">Checks a retained round&apos;s BLS signature and recomputes its value.</p>
            <label className="field"><span>Round (latest if blank)</span><input type="number" min="1" inputMode="numeric" value={proofRound} onChange={(event) => setProofRound(event.target.value)} placeholder={status?.round ? String(status.round) : ""} /></label>
            <button className="button primary" onClick={inspectProof} disabled={proofBusy}>{proofBusy ? "Verifying…" : "Verify round"}</button>
            {unreachable}
          </div>
          <div className="terminal">
            <div className="terminal-bar"><span>proof.explorer</span><span>{shownProof?.verified ? "pass" : "wait"}</span></div>
            <div className="terminal-body">
              <p>round........ {shownProof?.round || "—"}</p>
              <p>device....... {proofDevice}</p>
              <p>signature.... {shownProof?.signature ? `${shownProof.signature.slice(0, 32)}…` : "—"}</p>
              <p>group-key.... {shownProof?.groupKey ? `${shownProof.groupKey.slice(0, 32)}…` : "—"}</p>
              <p>value........ {shownProof?.value ?? "—"}</p>
              <p className={shownProof?.verified ? "pass" : "wait"}>proof........ {shownProof?.verified ? "verified" : shownProof ? "pending" : "—"}</p>
            </div>
          </div>
        </div>}

        {error && <p className="error" role="alert">{error}</p>}
      </div></section>
      <SiteFooter />
    </main>
  );
}
