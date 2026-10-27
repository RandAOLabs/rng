// The time-lock tier, live: the open round's validators locking in and
// revealing, and recent rounds with every answer re-checked in this page.
import { useEffect, useMemo, useState } from 'react';
import { readKey, short } from '../lib/beacon';
import { TIMELOCK } from '../lib/config';
import { roundValue, seedFor, verifyCrack, verifyReveal } from '../lib/timelock';

type Output = { y: string; via: 'reveal' | 'crack'; p?: string; proof?: string; cracker?: string };
type Round = { round: number; commits: Record<string, string>; outputs: Record<string, Output>; value: string; requests: number; opened: number; finalizedAt: number };
type Info = {
  round: number; price: number; params: { T: number; commitWindowMs: number };
  validators: { address: string; suspended: boolean; strikes: number }[];
  open: { round: number; phase: string; pending: number; active?: string[]; committed?: Record<string, string>; revealed?: string[] };
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

const PHASE: Record<string, string> = {
  collecting: 'Waiting for a request',
  commit: 'Validators are locking in their puzzles',
  reveal: 'Validators are revealing their answers',
};

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
  const rounds = useMemo(() => Object.values(state?.rounds ?? {}).sort((a, b) => b.round - a.round), [state]);
  if (!TIMELOCK) return null;

  const o = info?.open;
  const validators = info?.validators ?? [];
  return (
    <section className="block">
      <h2>Time-lock tier, live</h2>
      <p className="sub">
        Our flagship. Every validator locks in a puzzle, then reveals it; one honest validator keeps the result fair.
        Each answer below is re-checked in this page.
      </p>
      <div className="tl-open">
        <p className="tl-phase"><strong>Round {o?.round ?? '–'}</strong> {o ? PHASE[o.phase] ?? o.phase : 'Loading…'}</p>
        <ul className="tl-validators">
          {validators.map((v, i) => {
            const locked = !!o?.committed?.[v.address];
            const revealed = !!o?.revealed?.includes(v.address);
            const state = v.suspended ? 'suspended' : revealed ? 'revealed' : locked ? 'locked' : 'idle';
            return (
              <li key={v.address} className={`tl-v tl-${state}`}>
                <span className="tl-name">Validator {i + 1}</span>
                <span className="tl-state">{{ idle: 'Ready', locked: 'Locked in', revealed: 'Revealed', suspended: 'Suspended' }[state]}</span>
              </li>
            );
          })}
        </ul>
      </div>
      {rounds.length > 0 && (
        <table className="rounds">
          <thead><tr><th scope="col">Round</th><th scope="col">Answers</th><th scope="col">Took</th><th scope="col">Value</th><th scope="col">Check</th></tr></thead>
          <tbody>
            {rounds.slice(0, 6).map((r) => {
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
      )}
    </section>
  );
}
