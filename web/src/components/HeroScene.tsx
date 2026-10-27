// The live time-lock round in 3D (lib/scene.ts). Plays each finalized round
// from the time-lock beacon; with ?demo it plays stand-in rounds instead, and
// with ?record it waits for window.__scene.step() so frames can be captured.
import { useEffect, useRef, useState } from 'react';
import { readKey } from '../lib/beacon';
import { TIMELOCK } from '../lib/config';
import { demoRound, RoundScene, type Status } from '../lib/scene';

type Info = { validators: { address: string }[]; params: { revealWindowMs?: number } };
type State = { rounds: Record<string, { value: string; opened: number; commitClose: number; finalizedAt: number; outputs: Record<string, { via: string }> }> };

const params = new URLSearchParams(window.location.hash.split('?')[1] ?? window.location.search);

const CELLS = 20;
const bar = (p: number) => '█'.repeat(Math.round(p * CELLS)).padEnd(CELLS, '░');
const duration = (ms: number | null) => ms === null ? 'instant' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `~${(ms / 60_000).toFixed(1)} min`;

export function HeroScene({ fullscreen = false, fallback }: { fullscreen?: boolean; fallback?: React.ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const demo = params.has('demo') || !TIMELOCK;

  useEffect(() => {
    if (!canvas.current) return;
    const scene = new RoundScene(canvas.current);
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const record = params.has('record');
    let live = true;
    let poll: ReturnType<typeof setInterval> | undefined;
    scene.onFrame = (s) => live && setStatus(s);

    (async () => {
      try { await scene.init(); } catch { if (live) setFailed(true); return; }
      if (!live) return;
      canvas.current!.dataset.backend = scene.backend;

      if (demo) {
        let n = 4100;
        scene.push(demoRound(n++, Number(params.get('crack') ?? 2)));
        poll = setInterval(() => scene.push(demoRound(n++, Number(params.get('crack') ?? 2))), 1000);
      } else {
        let order: string[] = [];
        const tick = async () => {
          try {
            const [i, s] = await Promise.all([readKey<Info>('beaconinfo', TIMELOCK), readKey<State>('timelockstate', TIMELOCK)]);
            order = i.validators.map((v) => v.address);
            const latest = Object.keys(s.rounds ?? {}).map(Number).sort((a, b) => b - a)[0];
            if (latest === undefined) return;
            const r = s.rounds[String(latest)];
            const cracked = Object.entries(r.outputs).filter(([, o]) => o.via === 'crack').map(([a]) => order.indexOf(a)).filter((x) => x >= 0);
            const commit = r.commitClose - r.opened, after = r.finalizedAt - r.commitClose;
            const windowMs = i.params?.revealWindowMs ?? 10_000;
            const ms = cracked.length ? { commit, reveal: windowMs, crack: after - windowMs } : { commit, reveal: after };
            scene.push({ round: latest, value: r.value, cracked, ms });
          } catch { /* keep playing the last round */ }
        };
        await tick();
        poll = setInterval(tick, 1000);
      }

      if (record) {
        (window as unknown as { __scene: RoundScene }).__scene = scene;
        await scene.step(0);
      } else if (still) {
        await scene.step(5); // one frame with the round's value raised
      } else {
        scene.start();
      }
    })();

    return () => { live = false; clearInterval(poll); scene.dispose(); };
  }, [demo]);

  if (failed) return <>{fallback ?? null}</>;
  return (
    <figure className={fullscreen ? 'scene scene-full' : 'scene'}>
      <canvas ref={canvas} aria-hidden="true" />
      {status && status.bars.length > 0 && (
        <div className="scene-top" aria-hidden="true">
          <p className="scene-speed"><i className="scene-rec" />{status.speed}</p>
          <pre className="scene-bars">{status.bars.map((b) => `${b.name.padEnd(14)}${bar(b.progress)}  ${duration(b.realMs)}`).join('\n')}</pre>
        </div>
      )}
      <figcaption aria-live="polite">
        <span className="scene-round">$ rng watch --tier timelock{status?.round ? ` --round ${status.round}` : ''}{demo && !fullscreen ? ' --demo' : ''}</span>
        <span className="scene-phase">{'> '}{status?.label ?? 'starting'}<i className="scene-cursor" aria-hidden="true" /></span>
      </figcaption>
    </figure>
  );
}
