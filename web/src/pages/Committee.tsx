import { recentRounds, useBeacon } from '../lib/beacon';

export function CommitteePage() {
  const { info, state } = useBeacon(5000);
  const rounds = recentRounds(state);
  const members = info?.committee ?? [];
  const signedBy = (address: string) => rounds.filter((r) => r.signers.includes(address)).length;

  return (
    <section className="block narrow">
      <h1>Committee</h1>
      <p className="lede">
        {info ? `${members.length} nodes hold shares of one signing key. Any ${info.threshold} of them can sign a round; fewer cannot.` : 'Loading the committee…'}
        {' '}The key was made by a distributed key generation, so no machine has ever held all of it.
      </p>

      <table className="members">
        <thead>
          <tr><th scope="col">Node</th><th scope="col">Address</th><th scope="col">Signed (last {rounds.length} rounds)</th><th scope="col">Unclaimed fees</th><th scope="col">Conflicting posts</th></tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.address}>
              <td className="num">{m.index}</td>
              <td className="mono wrap">{m.address}</td>
              <td className="num">{signedBy(m.address)}</td>
              <td className="num">{state?.accrued?.[m.address] ?? 0} RNG</td>
              <td className="num">{state?.equivocations?.[m.address] ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Group key</h2>
      <p className="sub">Every round's signature verifies against this key (BLS12-381, 48 bytes).</p>
      <p className="mono wrap keybox">{info?.groupKey || '–'}</p>

      <h2>Earnings</h2>
      <p>Each node that signs a round earns 1 RNG per request in it; the protocol earns 1 RNG per request ({info?.protocolAccrued ?? 0} RNG so far, unclaimed). Nodes claim their fees with a <code>Claim</code> message.</p>

      <h2>Running a node</h2>
      <p>The launch committee is run by RandAO Labs. Seats open to outside operators, with staking and slashing, as the network grows. The node software is the <code>provider/</code> daemon in the repo: it posts its partial signature to the beacon, combines two, and attests the result, all through HyperBEAM.</p>
    </section>
  );
}
