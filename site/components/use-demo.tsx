"use client";

import { useEffect, useRef, useState } from "react";
import { SiteFooter, SiteHeader } from "./site-header";

const GAMES = {
  coin: { name: "Coin flip", verb: "Flip coin", sides: ["Heads", "Tails"] },
  wheel: { name: "Red or black", verb: "Spin wheel", sides: ["Red", "Black"] },
  doors: { name: "Dungeon doors", verb: "Open door", sides: ["Left door", "Right door"] },
} as const;

type Game = keyof typeof GAMES;
type Side = 0 | 1;
type Draw = { game: Game; side: Side; stake: number; fixture: number };
type Receipt = Draw & { outcome: Side; payout: number; waitMs: number; settleMs: number };
type BeaconRead = {
  round: number;
  value: string;
  readMs: number;
  roundMs: number | null;
};

const STAKES = [1, 2, 5, 10] as const;
const START_BALANCE = 100;
const FIXTURE_BYTES = [0x32, 0x57, 0xce, 0xa3, 0x81, 0x18, 0xf9, 0x60];
const BEACON_SOURCE = "https://lunar.arweave.net/#/explorer/ZKMf3AtF8kfDkSHXqQ0my5xbYH26nDVMofeiPb4fPPg/source";
const EXAMPLE = `// Run after the exact round is verified.
const bit = parseInt(round.value.slice(-1), 16) & 1;
const payout = bit === lockedChoice ? 2 * stake : 0;`;

function playOutcome(fixture: number): Side {
  return (FIXTURE_BYTES[fixture % FIXTURE_BYTES.length] & 1) as Side;
}

function PlayObject({ game, outcome, pending }: { game: Game; outcome?: Side; pending: boolean }) {
  return (
    <div className="use-stage" data-game={game} data-pending={pending} aria-hidden="true">
      {game === "coin" && (
        <div className="use-coin">
          <span>{outcome === undefined ? "RNG" : GAMES.coin.sides[outcome]}</span>
        </div>
      )}
      {game === "wheel" && (
        <div className="use-wheel">
          <span data-selected={outcome === 0}>Red</span>
          <span data-selected={outcome === 1}>Black</span>
        </div>
      )}
      {game === "doors" && (
        <div className="use-doors">
          <span data-selected={outcome === 0}>Left</span>
          <span data-selected={outcome === 1}>Right</span>
        </div>
      )}
    </div>
  );
}

export function UseDemo({ className }: { className: string }) {
  const [game, setGame] = useState<Game>("coin");
  const [side, setSide] = useState<Side>(0);
  const [stake, setStake] = useState<number>(2);
  const [balance, setBalance] = useState(START_BALANCE);
  const [pending, setPending] = useState<Draw | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [beacon, setBeacon] = useState<BeaconRead | null>(null);
  const [check, setCheck] = useState<"idle" | "checking" | "timeout" | "error">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const count = useRef(0);
  const replayTimer = useRef<number | null>(null);
  const activeCheck = useRef<AbortController | null>(null);

  useEffect(() => () => {
    if (replayTimer.current !== null) window.clearTimeout(replayTimer.current);
    const current = activeCheck.current;
    activeCheck.current = null;
    current?.abort();
  }, []);

  function selectGame(next: Game) {
    if (replayTimer.current !== null || next === game) return;
    setGame(next);
    setSide(0);
    setReceipt(null);
  }

  function play() {
    if (replayTimer.current !== null || stake > balance) return;
    const draw: Draw = { game, side, stake, fixture: count.current++ };
    const lockedAt = performance.now();
    setPending(draw);
    setReceipt(null);
    setBalance((value) => value - draw.stake);

    replayTimer.current = window.setTimeout(() => {
      const settledAt = performance.now();
      const outcome = playOutcome(draw.fixture);
      const payout = outcome === draw.side ? 2 * draw.stake : 0;
      setBalance((value) => value + payout);
      setReceipt({ ...draw, outcome, payout, waitMs: settledAt - lockedAt, settleMs: performance.now() - settledAt });
      setPending(null);
      replayTimer.current = null;
    }, 380);
  }

  function resetBalance() {
    if (replayTimer.current !== null) return;
    setBalance(START_BALANCE);
    setReceipt(null);
    count.current = 0;
  }

  async function checkBeacon() {
    if (activeCheck.current !== null) return;
    const request = new AbortController();
    activeCheck.current = request;
    setCheck("checking");
    const startedAt = performance.now();
    const timeout = window.setTimeout(() => request.abort(), 9_000);

    try {
      const response = await fetch("/api/anyhonest", { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error("Beacon check failed");
      const { proofValid, latest } = await response.json() as {
        proofValid?: boolean;
        latest?: { round?: number; value?: string; opened?: number; finalizedAt?: number };
      };
      if (!proofValid || typeof latest?.round !== "number" || !Number.isSafeInteger(latest.round)
          || typeof latest.value !== "string" || !/^[0-9a-f]{64}$/i.test(latest.value)) {
        throw new Error("Round proof unavailable");
      }
      if (activeCheck.current !== request) return;
      const { opened, finalizedAt } = latest;
      setBeacon({
        round: latest.round,
        value: latest.value,
        readMs: performance.now() - startedAt,
        roundMs: typeof opened === "number" && typeof finalizedAt === "number" && finalizedAt >= opened
          ? finalizedAt - opened : null,
      });
      setCheck("idle");
    } catch {
      if (activeCheck.current === request) setCheck(request.signal.aborted ? "timeout" : "error");
    } finally {
      window.clearTimeout(timeout);
      if (activeCheck.current === request) activeCheck.current = null;
    }
  }

  async function copyExample() {
    try {
      await navigator.clipboard.writeText(EXAMPLE);
      setCopyState("copied");
    } catch {
      setCopyState("manual");
    }
  }

  const chosen = GAMES[game];
  const displayedResult = receipt ? GAMES[receipt.game].sides[receipt.outcome] : null;
  const formatMs = (ms: number) => `${Math.round(ms).toLocaleString()} ms`;

  return (
    <main className={`shell ${className}`}>
      <SiteHeader active="use" />
      <div className="container use-wrap">
        <header className="use-heading">
          <div>
            <h1>Use it</h1>
            <p>Try three games with fictional play RNG.</p>
          </div>
          <div className="use-balance">
            <span>Play balance</span>
            <strong>{balance} RNG</strong>
          </div>
        </header>

        <div className="use-board">
          <section className="use-game" aria-label="Play a demo">
            <div className="use-games" role="group" aria-label="Game">
              {(Object.keys(GAMES) as Game[]).map((key) => (
                <button key={key} type="button" aria-pressed={game === key} disabled={Boolean(pending)} onClick={() => selectGame(key)}>
                  {GAMES[key].name}
                </button>
              ))}
            </div>
            <PlayObject game={game} outcome={receipt?.outcome} pending={Boolean(pending)} />
            <div className="use-controls">
              <div className="use-picks" role="group" aria-label="Pick a side">
                {chosen.sides.map((name, index) => (
                  <button key={name} type="button" aria-pressed={side === index} disabled={Boolean(pending)} onClick={() => setSide(index as Side)}>
                    {name}
                  </button>
                ))}
              </div>
              <div className="use-stakes" role="group" aria-label="Stake in play RNG">
                <span>Stake</span>
                {STAKES.map((amount) => (
                  <button key={amount} type="button" aria-label={`Stake ${amount} play RNG`} aria-pressed={stake === amount}
                    disabled={Boolean(pending) || amount > balance} onClick={() => setStake(amount)}>
                    {amount}
                  </button>
                ))}
              </div>
              <button className="button use-play" type="button" disabled={Boolean(pending) || stake > balance} onClick={play}>
                {chosen.verb} · {stake} RNG
              </button>
              <p className="use-rules">50/50 · A win returns 2× the stake.</p>
              {balance < stake && !pending && <button className="use-link" type="button" onClick={resetBalance}>Reset play balance</button>}
            </div>
          </section>

          <aside className="use-evidence" aria-label="Draw evidence">
            <section className="use-receipt">
              <h2>Draw receipt</h2>
              <p className="use-mode">Deterministic fixture replay</p>
              <div aria-live="polite" className="use-draw-status">
                {pending && <p className="use-result">Choice locked. Drawing…</p>}
                {receipt && <p className="use-result">{displayedResult} · {receipt.payout ? `Won ${receipt.payout} RNG` : "No payout"}</p>}
                {!pending && !receipt && <p>Play a draw to see its result and timings.</p>}
              </div>
              <dl className="use-data">
                <div><dt>Choice</dt><dd>{pending ? GAMES[pending.game].sides[pending.side] : receipt ? GAMES[receipt.game].sides[receipt.side] : "—"}</dd></div>
                <div><dt>Replay delay</dt><dd>{receipt ? formatMs(receipt.waitMs) : "—"}</dd></div>
                <div><dt>Local settlement</dt><dd>{receipt ? formatMs(receipt.settleMs) : "—"}</dd></div>
              </dl>
            </section>
            <section className="use-live">
              <h2>Live beacon</h2>
              <p className="use-mode">Read-only check, separate from play.</p>
              {beacon && (
                <dl className="use-data" aria-live="polite">
                  <div><dt>Verified round</dt><dd>#{beacon.round.toLocaleString()}</dd></div>
                  <div><dt>Round duration</dt><dd>{beacon.roundMs === null ? "—" : formatMs(beacon.roundMs)}</dd></div>
                  <div><dt>Read and verify</dt><dd>{formatMs(beacon.readMs)}</dd></div>
                  <div><dt>Round value</dt><dd><code title={beacon.value}>{beacon.value.slice(0, 16)}…</code></dd></div>
                </dl>
              )}
              <p className="use-check-state" role="status">
                {check === "checking" && "Checking round proof…"}
                {check === "timeout" && "The beacon check timed out. Try again."}
                {check === "error" && "A verified round is unavailable. Try again."}
              </p>
              <button className="button use-check" type="button" disabled={check === "checking"} onClick={checkBeacon}>
                {check === "timeout" || check === "error" ? "Retry beacon check" : "Check live beacon"}
              </button>
            </section>
          </aside>
        </div>

        <section className="use-integration" aria-labelledby="implementation">
          <div>
            <h2 id="implementation">Build your own</h2>
            <p>Lock the choice and stake before the chosen future round is known. Verify that round before settling.</p>
            <nav aria-label="Implementation sources">
              <a href="/docs/use">Integration guide</a>
              <a href="https://github.com/RandAOLabs/rng/blob/3f94da01c9d6b412ba7758019966dcd7e594950d/lib/rng.lua">Lua library</a>
              <a href="https://github.com/RandAOLabs/rng/tree/3f94da01c9d6b412ba7758019966dcd7e594950d/lib/js">JavaScript library</a>
              <a href={BEACON_SOURCE}>Contract in Lunar</a>
            </nav>
          </div>
          <div className="use-example">
            <pre><code>{EXAMPLE}</code></pre>
            <button className="use-link" type="button" onClick={copyExample}>
              {copyState === "copied" ? "Copied" : "Copy example"}
            </button>
            {copyState === "manual" && <p role="status">Select the code to copy it.</p>}
          </div>
        </section>
      </div>
      <SiteFooter />
    </main>
  );
}
