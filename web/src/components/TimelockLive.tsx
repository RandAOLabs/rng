// The time-lock tier, live: rounds run every second whether or not anyone is
// waiting, overlapping (the next locks in while the last reveals). Shows the
// newest value, the rounds in flight, the validators, and recent rounds with
// every answer re-checked in this page.
import { useEffect, useMemo, useState } from 'react';
import { readKey, short, useRoundHistory } from '../lib/beacon';
import { TIMELOCK } from '../lib/config';
import { roundValue, seedFor, verifyCrack, verifyReveal } from '../lib/timelock';

type Output = { y: string; via: 'reveal' | 'crack'; p?: string; proof?: string; cracker?: string };
type Round = { round: number; commits: Record<string, string>; outputs: Record<string, Output>; value: string; requests: number; opened: number; finalizedAt: number };
type InFlight = { round: number; phase: string; pending: number; revealDeadline?: number };
type Info = {
  round: number; price: number; params: { T: number; commitWindowMs: number; heartbeat?: number };
  validators: { address: string; suspended: boolean; idle?: boolean; strikes: number; bond?: number }[];
  open: InFlight; revealing?: InFlight[];
};
type State = { self: string; params: { T: number }; rounds: Record<string, Round> };

const checked = new Map<string, boolean>();
function checkRound(st: State, r: Round): boolean {
  const key = `${r.round}|${r.value}`;
  if (!checked.has(key)) {
    const ys: Record<string, string> = {};
    let ok = true;
    for (const [a, o] of Object.entries(r.outputs)) {
      ys[a] = o.y;
      const seed = seedFor(st.self, r.round, a);
      ok = ok && (o.via === 'crack' ? verifyCrack(r.commits[a], seed, st.params.T, o.y, o.proof!) : verifyReveal(r.commits[a], seed, st.params.T, o.y, o.p!));
    }
    checked.set(key, ok && roundValue(st.self, r.round, ys) === r.value);
  }
  return checked.get(key)!;
}

function phaseOf(r: InFlight) {
  if (r.phase === 'reveal') return r.revealDeadline && Date.now() > r.revealDeadline ? 'being cracked' : 'revealing';
  return r.phase === 'commit' ? 'locking in' : 'starting';
}

/** Rounds a minute over the history seen so far. */
function perMinute(rounds: Round[]) {
  const ts = rounds.map((r) => r.finalizedAt).sort((a, b) => a - b);
  if (ts.length < 3) return null;
  return Math.round(((ts.length - 1) / (ts[ts.length - 1] - ts[0])) * 60_000);
}

export function TimelockLive() {
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<State | null>(null);
  useEffect(() => {
    if (!TIMELOCK) return;
    let live = true;
    const tick = async () => {
      try {
        const [i, s] = await Promise.all([readKey<Info>('beaconinfo', TIMELOCK), readKey<State>('timelockstate', TIMELOCK)]);
        if (live) { setInfo(i); setState(s); }
      } catch { /* keep the last view */ }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const published = useMemo(() => Object.values(state?.rounds ?? {}), [state]);
  const rounds = useRoundHistory(published);
  if (!TIMELOCK) return null;

  const validators = info?.validators ?? [];
  const inFlight = info ? [...(info.revealing ?? []), info.open].sort((a, b) => b.round - a.round) : [];
  const newest = rounds[0];
  const rate = perMinute(rounds);
  return (
    <section className="block">
      <h2>Time-lock tier, live</h2>
      <p className="sub">
        Our flagship. Every validator locks in a puzzle, then reveals it; one honest validator keeps the result fair.
        A new round starts every second whether anyone is waiting or not, so a request joins the next one.
        Each answer below is re-checked in this page.
      </p>
      <div className="tl-open">
        <div className="tl-now">
          <span className="tl-label">Newest value</span>
          <span key={newest?.value} className="tl-value mono">{newest ? newest.value : 'Waiting for the first round…'}</span>
          {newest && (
            <span className="tl-meta">
              Round {newest.round}, {((newest.finalizedAt - newest.opened) / 1000).toFixed(1)} s from first lock-in to value
              {rate !== null && `, ${rate} rounds a minute`}
            </span>
          )}
        </div>
        {inFlight.length > 0 && (
          <p className="tl-flight">
            <span className="tl-label">In flight</span>
            {inFlight.map((r) => (
              <span key={r.round} className={`tl-chip tl-chip-${phaseOf(r).replace(' ', '-')}`}>
                {r.round} {phaseOf(r)}{r.pending ? `, ${r.pending} waiting` : ''}
              </span>
            ))}
          </p>
        )}
        <ul className="tl-validators">
          {validators.map((v, i) => {
            const state = v.suspended ? (v.idle ? 'idle' : 'suspended') : 'active';
            return (
              <li key={v.address} className={`tl-v tl-${state}`}>
                <span className="tl-name">Validator {i + 1}</span>
                <span className="tl-state">
                  {{ active: 'Active', idle: 'Offline, rejoins when back', suspended: 'Suspended and slashed' }[state]}
                  {v.bond !== undefined && `. Bond ${v.bond.toLocaleString()} RNG`}
                  {v.strikes > 0 && `, ${v.strikes} ${v.strikes === 1 ? 'strike' : 'strikes'}`}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      {rounds.length > 0 && (
        <div className="rounds-scroll" tabIndex={0} aria-label="Time-lock rounds, newest first">
        <table className="rounds">
          <thead><tr><th scope="col">Round</th><th scope="col">Answers</th><th scope="col">Took</th><th scope="col">Value</th><th scope="col">Check</th></tr></thead>
          <tbody>
            {rounds.map((r) => {
              const cracks = Object.values(r.outputs).filter((x) => x.via === 'crack').length;
              const ok = state ? checkRound(state, r) : null;
              return (
                <tr key={r.round}>
                  <td className="num">{r.round}</td>
                  <td>{Object.keys(r.outputs).length} revealed{cracks ? `, ${cracks} cracked` : ''}</td>
                  <td className="num">{((r.finalizedAt - r.opened) / 1000).toFixed(1)} s</td>
                  <td className="mono" title={r.value}>{short(r.value, 8)}</td>
                  <td>{ok === null ? <span className="check">Checking</span> : ok ? <span className="check ok">Verified</span> : <span className="check bad">Does not verify</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}
