import { useEffect, useState } from 'react';
import { readKey, useBeacon } from '../lib/beacon';
import { BEACON, TIMELOCK, TOKEN, UNIT } from '../lib/config';
import { dieFor, requestValue, verifySignature } from '../lib/crypto';
import { roundValue, seedFor, verifyCrack, verifyReveal } from '../lib/timelock';
import { connect, hasWallet, send } from '../lib/wallet';

type Tier = 'timelock' | 'quick';
type Draw = { tier: Tier; requestId: string; round: number; value?: string; die?: number; verified?: boolean };
type TlOutput = { y: string; via: 'reveal' | 'crack'; p?: string; proof?: string };
type TlRound = { commits: Record<string, string>; outputs: Record<string, TlOutput>; value: string };
type TlState = { self: string; params: { T: number }; balances: Record<string, number>; rounds: Record<string, TlRound> };

/** Every reveal and crack of a time-lock round, re-checked here. */
function verifyTimelockRound(st: TlState, round: number, r: TlRound): boolean {
  const ys: Record<string, string> = {};
  for (const [a, o] of Object.entries(r.outputs)) {
    const seed = seedFor(st.self, round, a);
    const ok = o.via === 'crack' ? verifyCrack(r.commits[a], seed, st.params.T, o.y, o.proof!) : verifyReveal(r.commits[a], seed, st.params.T, o.y, o.p!);
    if (!ok) return false;
    ys[a] = o.y;
  }
  return roundValue(st.self, round, ys) === r.value;
}

function useTimelock(everyMs = 1500) {
  const [price, setPrice] = useState<number | null>(null);
  const [state, setState] = useState<TlState | null>(null);
  useEffect(() => {
    if (!TIMELOCK) return;
    let live = true;
    const tick = async () => {
      try {
        const [i, s] = await Promise.all([readKey<{ price: number }>('beaconinfo', TIMELOCK), readKey<TlState>('timelockstate', TIMELOCK)]);
        if (live) { setPrice(i.price); setState(s); }
      } catch { /* keep the last view */ }
    };
    tick();
    const t = setInterval(tick, everyMs);
    return () => { live = false; clearInterval(t); };
  }, [everyMs]);
  return { price, state };
}

export function TryPage() {
  const quick = useBeacon(2000);
  const tl = useTimelock();
  const [tier, setTier] = useState<Tier>(TIMELOCK ? 'timelock' : 'quick');
  const [address, setAddress] = useState<string | null>(null);
  const [tokens, setTokens] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draw, setDraw] = useState<Draw | null>(null);

  const beacon = tier === 'timelock' ? TIMELOCK : BEACON;
  const balances = tier === 'timelock' ? tl.state?.balances : quick.state?.balances;
  const credit = address && balances ? balances[address] ?? 0 : 0;
  const price = (tier === 'timelock' ? tl.price : quick.info?.price.beacon) ?? (tier === 'timelock' ? 4 : 3);

  async function refreshTokens(addr = address) {
    if (!addr) return;
    try { setTokens(Number((await readKey<Record<string, string>>('balances', TOKEN))[addr] ?? 0) / UNIT); }
    catch { setTokens(0); }
  }
  useEffect(() => { refreshTokens(); }, [address]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const onConnect = () => run('Connecting', async () => { const a = await connect(); setAddress(a); await refreshTokens(a); });
  const onFaucet = () => run('Getting TEST-RNG', async () => {
    const { reply } = await send(TOKEN, { Action: 'Faucet' });
    if (reply?.error) throw new Error(reply.error);
    await refreshTokens();
  });
  const onFund = () => run('Funding', async () => {
    const { reply } = await send(TOKEN, { Action: 'Transfer', Recipient: beacon, Quantity: String(price * 3 * UNIT), 'X-For': address! });
    if (reply?.error) throw new Error(reply.error);
    await refreshTokens();
  });
  const onDraw = () => run('Requesting', async () => {
    const requestId = `try-${Date.now()}`;
    const { reply } = await send(beacon, { Action: 'Request-Random', Tier: tier, 'Request-Id': requestId });
    if (reply?.error) throw new Error(reply.error === 'Insufficient-Balance' ? `Your balance on this tier is too low. Fund it with at least ${price} RNG.` : reply.error);
    setDraw({ tier, requestId, round: reply.round });
  });

  // Resolve the draw once its round is in the published state.
  useEffect(() => {
    if (!draw || draw.value) return;
    if (draw.tier === 'quick' && quick.state) {
      const r = quick.state.rounds?.[String(draw.round)];
      if (!r) return;
      const value = requestValue(r.value, draw.requestId);
      setDraw({ ...draw, value, die: dieFor(value), verified: verifySignature(quick.state.groupKey, `${quick.state.self}|${draw.round}`, r.signature) });
    }
    if (draw.tier === 'timelock' && tl.state) {
      const r = tl.state.rounds?.[String(draw.round)];
      if (!r) return;
      const value = requestValue(r.value, draw.requestId);
      setDraw({ ...draw, value, die: dieFor(value), verified: verifyTimelockRound(tl.state, draw.round, r) });
    }
  }, [quick.state, tl.state, draw]);

  const step = !address ? 1 : (tokens ?? 0) < price && credit < price ? 2 : credit < price ? 3 : 4;

  return (
    <section className="block narrow">
      <h1>Try a draw</h1>
      <p className="lede">
        Request a random value with your own wallet on the testnet. TEST-RNG is free from the faucet and has no value.
      </p>

      {TIMELOCK && (
        <div className="tier-pick" role="radiogroup" aria-label="Tier">
          {(['timelock', 'quick'] as Tier[]).map((t) => (
            <button key={t} role="radio" aria-checked={tier === t} className={tier === t ? 'pick on' : 'pick'}
              onClick={() => { setTier(t); setDraw(null); setError(null); }}>
              <strong>{t === 'timelock' ? 'Time-lock' : 'Quick'}</strong>
              <span>{t === 'timelock' ? 'Fair while any one validator is honest' : '2-of-3 committee signature'}</span>
            </button>
          ))}
        </div>
      )}

      <ol className="flow">
        <li className={step > 1 ? 'done' : step === 1 ? 'now' : ''}>
          <h3>Connect a wallet</h3>
          {address ? <p className="mono">{address}</p> : (
            <>
              <p>Wander (or any Arweave wallet) signs each message in the browser.</p>
              <button className="button" onClick={onConnect} disabled={!!busy}>{hasWallet() ? 'Connect wallet' : 'Install Wander to continue'}</button>
            </>
          )}
        </li>
        <li className={step > 2 ? 'done' : step === 2 ? 'now' : ''}>
          <h3>Get TEST-RNG</h3>
          <p>You hold {tokens === null ? '–' : tokens} TEST-RNG. The faucet gives 100 per request, up to 1,000 per wallet.</p>
          <button className="button" onClick={onFaucet} disabled={!address || !!busy}>Get 100 TEST-RNG</button>
        </li>
        <li className={step > 3 ? 'done' : step === 3 ? 'now' : ''}>
          <h3>Fund your balance</h3>
          <p>Draws are paid from a balance held by the {tier === 'timelock' ? 'time-lock' : 'quick'} beacon. Yours is {address ? credit : '–'} RNG; one draw costs {price}.</p>
          <button className="button" onClick={onFund} disabled={!address || (tokens ?? 0) < price * 3 || !!busy}>Fund {price * 3} RNG (3 draws)</button>
        </li>
        <li className={step === 4 ? 'now' : ''}>
          <h3>Draw</h3>
          <p>{tier === 'timelock'
            ? 'Your request joins the next round. Every validator locks in a puzzle, then reveals it; your number comes from all of them.'
            : 'Your request joins the next round. Any 2 of the 3 validators sign it.'}</p>
          <button className="button" onClick={onDraw} disabled={!address || credit < price || !!busy || (!!draw && !draw.value)}>Request a random value</button>
        </li>
      </ol>

      {busy && <p className="notice" role="status">{busy}… approve the message in your wallet if it asks.</p>}
      {error && <p className="notice bad" role="alert">{error}</p>}

      {draw && (
        <div className="result" aria-live="polite">
          {draw.value ? (
            <>
              <div className="die" aria-label={`You rolled ${draw.die}`}>{draw.die}</div>
              <dl className="facts">
                <div><dt>Round</dt><dd className="num">{draw.round}</dd></div>
                <div><dt>Your value</dt><dd className="mono wrap">{draw.value}</dd></div>
                <div><dt>{draw.tier === 'timelock' ? 'Every reveal' : 'Signature'}</dt><dd>{draw.verified ? <span className="check ok">Verified</span> : <span className="check bad">Does not verify</span>}</dd></div>
              </dl>
              <p className="sub">The die is <code>r:int(1, 6)</code> from <code>lib/rng.lua</code>'s stream over your value, so a process drawing from the same result gets the same roll.</p>
            </>
          ) : (
            <p>Waiting for round {draw.round}…</p>
          )}
        </div>
      )}
    </section>
  );
}
