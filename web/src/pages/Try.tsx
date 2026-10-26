import { useEffect, useState } from 'react';
import { readKey, useBeacon } from '../lib/beacon';
import { BEACON, TOKEN, UNIT } from '../lib/config';
import { dieFor, requestValue, verifySignature } from '../lib/crypto';
import { connect, hasWallet, send } from '../lib/wallet';

type Draw = { requestId: string; round: number; value?: string; die?: number; verified?: boolean };

export function TryPage() {
  const { info, state } = useBeacon(2000);
  const [address, setAddress] = useState<string | null>(null);
  const [tokens, setTokens] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draw, setDraw] = useState<Draw | null>(null);

  const credit = address && state ? state.balances?.[address] ?? 0 : 0;
  const price = info?.price.beacon ?? 3;

  async function refreshTokens(addr = address) {
    if (!addr) return;
    try { setTokens(Number(await readKey<string>(`balance-${addr}`, TOKEN)) / UNIT); }
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
    const { reply } = await send(TOKEN, { Action: 'Transfer', Recipient: BEACON, Quantity: String(price * 3 * UNIT), 'X-For': address! });
    if (reply?.error) throw new Error(reply.error);
    await refreshTokens();
  });
  const onDraw = () => run('Requesting', async () => {
    const requestId = `try-${Date.now()}`;
    const { reply } = await send(BEACON, { Action: 'Request-Random', Tier: 'beacon', 'Request-Id': requestId });
    if (reply?.error) throw new Error(reply.error === 'Insufficient-Balance' ? `Your beacon balance is too low. Fund it with at least ${price} RNG.` : reply.error);
    setDraw({ requestId, round: reply.round });
  });

  // Resolve the draw once its round is in the published state.
  useEffect(() => {
    if (!draw || draw.value || !state) return;
    const r = state.rounds?.[String(draw.round)];
    if (!r) return;
    const value = requestValue(r.value, draw.requestId);
    setDraw({ ...draw, value, die: dieFor(value), verified: verifySignature(state.groupKey, `${state.self}|${draw.round}`, r.signature) });
  }, [state, draw]);

  const step = !address ? 1 : (tokens ?? 0) < price && credit < price ? 2 : credit < price ? 3 : 4;

  return (
    <section className="block narrow">
      <h1>Try a draw</h1>
      <p className="lede">
        Request a beacon value with your own wallet on the testnet. TEST-RNG is free from the faucet and has no value.
      </p>

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
          <h3>Fund your beacon balance</h3>
          <p>Draws are paid from a balance held by the beacon. Yours is {address ? credit : '–'} RNG; one draw costs {price}.</p>
          <button className="button" onClick={onFund} disabled={!address || (tokens ?? 0) < price * 3 || !!busy}>Fund {price * 3} RNG (3 draws)</button>
        </li>
        <li className={step === 4 ? 'now' : ''}>
          <h3>Draw</h3>
          <p>Your request is bound to the next round. The committee signs it within a few seconds.</p>
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
                <div><dt>Signature</dt><dd>{draw.verified ? <span className="check ok">Verified</span> : <span className="check bad">Does not verify</span>}</dd></div>
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
