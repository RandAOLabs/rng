import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { EntropyPlate } from '../components/EntropyPlate';
import { recentRounds, short, useBeacon } from '../lib/beacon';
import { roundValue, verifySignature } from '../lib/crypto';

const checked = new Map<string, boolean>(); // signature -> verified, so each is checked once

function useVerified(groupKey: string | undefined, self: string | undefined, round: number, signature: string) {
  return useMemo(() => {
    if (!groupKey || !self) return null;
    if (!checked.has(signature)) checked.set(signature, verifySignature(groupKey, `${self}|${round}`, signature));
    return checked.get(signature)!;
  }, [groupKey, self, round, signature]);
}

function Check({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="check">Checking</span>;
  return ok ? <span className="check ok">Verified</span> : <span className="check bad">Does not verify</span>;
}

function RoundRow({ r, groupKey, self, members }: { r: { round: number; signature: string; value: string; signers: string[] }; groupKey?: string; self?: string; members: Record<string, number> }) {
  const ok = useVerified(groupKey, self, r.round, r.signature);
  const valueOk = roundValue(r.signature) === r.value;
  return (
    <tr>
      <td className="num">{r.round}</td>
      <td>{r.signers.map((s) => `Node ${members[s] ?? '?'}`).join(', ')}</td>
      <td className="mono" title={r.value}>{short(r.value, 8)}</td>
      <td><Check ok={ok === null ? null : ok && valueOk} /></td>
    </tr>
  );
}

export function BeaconPage() {
  const { info, state, error } = useBeacon();
  const rounds = recentRounds(state);
  const latest = rounds[0];
  const latestOk = useVerified(state?.groupKey, state?.self, latest?.round ?? 0, latest?.signature ?? '');
  const members = state?.committee ?? {};

  return (
    <>
      <section className="hero">
        <div className="hero-text">
          <h1>Randomness your AO process can prove.</h1>
          <p className="lede">
            HyperBEAM switched off math.random because nodes could disagree or steer it. RandAO
            brings it back safely, from free local draws up to time-lock rounds where one honest
            validator keeps every draw fair.
          </p>
          <p className="actions">
            <Link className="button" to="/try">Try a draw</Link>
            <Link className="button quiet" to="/docs">Read the docs</Link>
          </p>
        </div>
        <div className="hero-plate">
          <EntropyPlate signature={latest?.signature ?? null} round={latest?.round ?? null} />
          <dl className="facts">
            <div><dt>Round</dt><dd className="num">{latest ? latest.round : '–'}</dd></div>
            <div><dt>Signature</dt><dd>{latest ? <Check ok={latestOk} /> : 'No rounds yet'}</dd></div>
            <div><dt>Waiting for the next round</dt><dd>{info ? `${info.pendingCount} ${info.pendingCount === 1 ? 'request' : 'requests'}` : '–'}</dd></div>
            <div><dt>Price per request</dt><dd>{info ? `${info.price.beacon} RNG` : '–'}</dd></div>
          </dl>
        </div>
      </section>

      {error && <p className="notice bad" role="status">Can't reach the beacon: {error} Retrying every few seconds.</p>}

      <section className="block">
        <h2>Recent rounds</h2>
        <p className="sub">
          Each signature is checked in this page against the committee's public key. Nothing here is taken on trust.
        </p>
        {rounds.length === 0 ? (
          <p className="empty">No rounds yet. A round is signed only when someone is waiting for one. <Link to="/try">Request one</Link>.</p>
        ) : (
          <table className="rounds">
            <thead><tr><th scope="col">Round</th><th scope="col">Signed by</th><th scope="col">Value</th><th scope="col">Check</th></tr></thead>
            <tbody>
              {rounds.slice(0, 12).map((r) => <RoundRow key={r.round} r={r} groupKey={state?.groupKey} self={state?.self} members={members} />)}
            </tbody>
          </table>
        )}
      </section>

      <section className="block">
        <h2>How a round is made</h2>
        <ol className="steps">
          <li><strong>You ask.</strong> Your process sends Request-Random. The beacon takes the price from your balance and binds the request to the next round, which nobody has signed yet.</li>
          <li><strong>Nodes sign.</strong> Each committee node signs the round with its share of a key that no single machine has ever held.</li>
          <li><strong>Two shares make one signature.</strong> Any two partial signatures combine into the same 96-byte signature, so no node can choose the outcome.</li>
          <li><strong>You get your number.</strong> The beacon hashes the signature with your request id and sends the result to your process.</li>
        </ol>
      </section>
    </>
  );
}
