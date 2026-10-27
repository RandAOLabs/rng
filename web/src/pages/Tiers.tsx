import { Link } from 'react-router-dom';

type Tier = {
  key: string; name: string; line: string; price: string;
  speed: number; speedText: string; security: number; securityText: string;
  cheat: string; steps: string[];
};

const TIERS: Tier[] = [
  {
    key: 'local', name: 'Local', line: 'Free randomness inside your own message.',
    price: 'Free', speed: 3, speedText: 'Same message',
    security: 1, securityText: 'Basic',
    cheat: 'The sender, by re-signing until it likes the roll.',
    steps: ['Your process hashes its own message id, slot and time.', 'The library turns that into a stream of numbers.', 'Your code runs immediately.'],
  },
  {
    key: 'quick', name: 'Quick', line: 'A committee signature, in about a second.',
    price: '3 RNG', speed: 2, speedText: '~1 s',
    security: 2, securityText: 'Committee',
    cheat: '2 of the 3 validators working together could see rounds early.',
    steps: ['Your request joins the next round.', 'Each validator signs it with its share of one key.', 'Any 2 shares make the same signature; its hash is your number.'],
  },
  {
    key: 'timelock', name: 'Time-lock', line: 'Our original protocol: safe while any one validator is honest.',
    price: '4 RNG', speed: 1, speedText: '~3–5 s',
    security: 3, securityText: 'Any one honest',
    cheat: 'Only every validator together. A stalled validator is cracked open, so it can delay but never steer.',
    steps: [
      'Every validator locks in a time-lock puzzle for the round.',
      'Once all are locked, each reveals its answer with the puzzle\'s secret key; the node checks it instantly.',
      'A validator that stays silent gets its puzzle solved the slow way by the others.',
      'All answers are hashed together into your number.',
    ],
  },
];

function Meter({ value, label }: { value: number; label: string }) {
  return (
    <span className="meter" role="img" aria-label={`${label}: ${value} of 3`}>
      {[1, 2, 3].map((i) => <i key={i} className={i <= value ? 'on' : ''} />)}
    </span>
  );
}

const snippet = `-- the same continuation, three levels of safety
rng.request(msg, { tier = "local",    on = "Loot-Roll" })   -- free, instant
rng.request(msg, { tier = "quick",    on = "Loot-Roll" })   -- ~1 s
rng.request(msg, { tier = "timelock", on = "Loot-Roll" })   -- any-one-honest`;

export function TiersPage() {
  return (
    <section className="block tiers-page">
      <h1>Pick how safe each draw needs to be</h1>
      <p className="lede">
        One library, any security level per call. Start with free local randomness, and switch one
        option to the time-lock tier when real value is on the line.
      </p>

      <div className="tiers" role="list">
        {TIERS.map((t) => (
          <article key={t.key} className={`tier tier-${t.key}`} role="listitem">
            <h2>{t.name}</h2>
            <p className="tier-line">{t.line}</p>
            <dl>
              <div><dt>Price per draw</dt><dd>{t.price}</dd></div>
              <div><dt>Speed</dt><dd><Meter value={t.speed} label="Speed" /> {t.speedText}</dd></div>
              <div><dt>Security</dt><dd><Meter value={t.security} label="Security" /> {t.securityText}</dd></div>
              <div><dt>Who could cheat</dt><dd className="cheat">{t.cheat}</dd></div>
            </dl>
            <h3>How it works</h3>
            <ol className="tier-steps">{t.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          </article>
        ))}
      </div>

      <h2>Switching is one option</h2>
      <pre><code>{snippet}</code></pre>
      <p className="sub">
        Prices are 1 RNG to each validator that served the draw plus 1 RNG to the protocol, so they follow
        the size of the validator set. The time-lock tier's worst case is a validator going silent: its
        puzzle is solved the slow way, which delays that round by a few minutes and changes nothing else.
        <Link to="/docs"> Read the docs</Link>.
      </p>
    </section>
  );
}
