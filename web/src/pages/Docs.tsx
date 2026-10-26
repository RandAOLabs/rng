import { BEACON, NODE, REPO, TOKEN } from '../lib/config';

const quickstart = `local rng = require("rng")            -- lib/rng.lua from the repo

rng.on("Loot-Roll", function(r, ctx)  -- named, so it survives reloads
  grantLoot(ctx.player, r:int(1, 6))
end)

-- Free, local: runs now, inside this message.
rng.request(msg, { on = "Loot-Roll", ctx = { player = msg.From } })`;

const upgrade = `rng.config({ beacon = "${BEACON}" })

-- Same continuation, now backed by the beacon. Runs when the round lands.
rng.request(msg, { tier = "beacon", on = "Loot-Roll", ctx = { player = msg.From } })`;

const native = `function compute(base, req)
  base.results = { outbox = {} }
  rng.config({ beacon = BEACON, outbox = base.results.outbox })
  local msg, from = req.body, actor(req.body, base)   -- your proven sender
  if msg.action == "RNG-Result" then rng.handle(msg, from) end
  -- ...
end`;

const shim = `rng.install(msg)        -- math.random now draws from a local stream
local roll = math.random(1, 6)`;

export function DocsPage() {
  return (
    <article className="block narrow docs">
      <h1>Docs</h1>
      <p className="lede">
        One library covers every security level. Start with free local randomness, then switch a call to the
        beacon when what's at stake grows. Your code stays the same.
      </p>

      <h2 id="quickstart">Quickstart</h2>
      <p>Copy <a href={`${REPO}/blob/main/lib/rng.lua`}>lib/rng.lua</a> into your process. Every call takes a named continuation, so moving to a paid tier never needs a rewrite.</p>
      <pre><code>{quickstart}</code></pre>
      <p>Each <code>r</code> is a deterministic SHA-256 stream: replays and other nodes draw the same numbers. It offers <code>r:int(lo, hi)</code>, <code>r:float()</code>, <code>r:pick(t)</code>, <code>r:shuffle(t)</code>, <code>r:bytes(n)</code> and <code>r:random(...)</code> with <code>math.random</code>'s shapes.</p>

      <h2 id="beacon">Use the beacon</h2>
      <pre><code>{upgrade}</code></pre>
      <p>Fund your process's balance first: send TEST-RNG to the beacon. The <code>Credit-Notice</code> credits the sender, or the address in an <code>X-For</code> tag.</p>

      <h2 id="tiers">Security tiers</h2>
      <table>
        <thead><tr><th scope="col">Tier</th><th scope="col">Where the value comes from</th><th scope="col">Who could bias it</th><th scope="col">Price</th></tr></thead>
        <tbody>
          <tr><td><code>local</code></td><td>Hash of the message id, slot and time</td><td>The sender, by re-signing until it likes the roll</td><td>Free</td></tr>
          <tr><td><code>fast</code> (planned)</td><td>One provider's BLS signature over your request id</td><td>That provider, only by refusing to answer</td><td>2 RNG</td></tr>
          <tr><td><code>beacon</code></td><td>A round signed by 2 of the 3 committee nodes</td><td>2 or more nodes working together</td><td>3 RNG</td></tr>
          <tr><td><code>max</code> (planned)</td><td>The beacon value fed through a delay function</td><td>Practically no one</td><td>4 RNG</td></tr>
        </tbody>
      </table>
      <p>Price rule: 1 RNG to each node that served the request, plus 1 RNG to the protocol.</p>

      <h2 id="native">Native HyperBEAM processes</h2>
      <p>Processes that define their own <code>compute</code> have no <code>ao.send</code>. Point the library at your outbox for each message and pass the sender you proved from the signature.</p>
      <pre><code>{native}</code></pre>

      <h2 id="shim">Old code that calls math.random</h2>
      <p>RC7 sandboxes <code>math.random</code>. This keeps existing code running at the local tier:</p>
      <pre><code>{shim}</code></pre>

      <h2 id="api">Beacon messages</h2>
      <table>
        <thead><tr><th scope="col">Action</th><th scope="col">Send</th><th scope="col">What happens</th></tr></thead>
        <tbody>
          <tr><td><code>Request-Random</code></td><td><code>Tier</code>, <code>Request-Id</code></td><td>Debits the price, binds the request to the next round. Errors come back as <code>RNG-Error</code>.</td></tr>
          <tr><td><code>Withdraw</code></td><td><code>Quantity</code> (optional)</td><td>Returns unused RNG to you.</td></tr>
          <tr><td><code>Balance</code></td><td><code>Account</code> (optional)</td><td>Replies with the balance.</td></tr>
          <tr><td><code>Get-Info</code></td><td></td><td>Replies with round, committee and prices.</td></tr>
        </tbody>
      </table>
      <p>Your process receives <code>RNG-Result</code>: <code>{'{ round, signature, results = { { requestId, value } } }'}</code>. A request's value is <code>SHA-256(SHA-256("round|" .. signature) .. "|" .. requestId)</code>; the signature verifies against the group key for the message <code>&lt;beacon id&gt;|&lt;round&gt;</code>.</p>

      <h2 id="reads">Free reads</h2>
      <p>No signing needed: <code>GET {NODE}/{'<beacon>'}~process@1.0/now/beaconinfo</code> (round, committee, prices) and <code>…/now/beaconstate</code> (balances and recent rounds with their signatures).</p>

      <h2 id="testnet">Testnet</h2>
      <table>
        <tbody>
          <tr><th scope="row">Node</th><td className="mono">{NODE}</td></tr>
          <tr><th scope="row">Beacon</th><td className="mono wrap">{BEACON}</td></tr>
          <tr><th scope="row">TEST-RNG</th><td className="mono wrap">{TOKEN}</td></tr>
        </tbody>
      </table>
    </article>
  );
}
