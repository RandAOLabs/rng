# Use it

How a wallet or an AO process gets randomness from each tier, with the exact
messages. Every tag below is taken from the code: `lib/rng.lua`,
`lib/fair.lua`, `lib/js/fair-client.ts`, `protocol/beacon/beacon.lua` (Fast),
`protocol/beacon/anyhonest.lua` (Any-Honest) and `protocol/fair/fair.lua`.
Process ids are from [`deploy/v3-mainnet.json`](../deploy/v3-mainnet.json).

## Pick a tier

| Tier | Use it when | Safe unless | Price | Process |
|---|---|---|---|---|
| Local | the sender learning the result first does no harm | always predictable to the sender | free | none (`lib/rng.lua` in your process) |
| Fast | you want one value quickly and trust 2 of 3 operators not to collude | 2 of the 3 committee operators collude | 3 RNG | `NBpbTl643CXrRx3IIbN712O2_ZXbhbbFJZZhlcmOTsY` |
| Any-Honest | nobody in the round may predict or steer the value | every validator in the round colludes | 4 RNG | `98AkinkWAtW2NM-csO-D1GNI-lJqf3xWbX-TgeupWUM` |
| Fair play | a player must not have to trust the game, the operators or the validators | never, for an honest player | 4 RNG per batch, split over its sessions | `zEI8l8oaThgvIzd60ZyioW6TLZR10yKoeMTgp56TopE` |

All payments are in the RNG token `n7snPbrtwBA4LIlYMHHavzSZSrbUmheSLhw1uuX-KSY`
(6 decimals: 1 RNG = 1,000,000 atoms). There is no faucet. Every process here
runs on the scheduler `tkqULqMDeHKXCN79Cm_bDIV560JxXl6pBSmdPgxqwSw`.

The prices above are the live defaults (`deploy/v3-params.json`). The DAO can
change them, so read them before you pay:

- Fast: `beaconinfo.price.fast` (whole RNG) and `beaconinfo.unit`.
- Any-Honest: `beaconinfo.priceSchedule.request`, `.subscription` and
  `.subscriptionRounds`.
- Fair play: `fairinfo.requestPriceAtoms`.

## Sending and reading

A published key is read with
`GET <node>/<process>~process@1.0/now/<key>` on a HyperBEAM node that computes
these processes (send `accept: application/ao` to get the process JSON itself).

A message is a signed ANS-104 data item whose target is the process. A browser
wallet signs it and the client sends it to the process's scheduler:

1. `POST <node>/<process>~process@1.0/schedule?codec-device=ans104@1.0`
   (body: the signed item, `content-type: application/ans104`). The reply's
   `slot` header is the message's slot.
2. `GET <node>/<process>~process@1.0/push&slot=<slot>` delivers its outbox.
3. `GET <node>/<process>~process@1.0/compute&slot=<slot>/results/output/data`
   is the process's reply to it. A refusal is `{ "error": "<code>" }`.

randao.net proxies exactly these three calls for the console under
`/hb-stage/`; it does not proxy `now/` reads. `site/lib/wallet.ts` (Wander)
and `FairClient.send` in `lib/js/fair-client.ts` (a browser key) do this.

An aos process sends with `ao.send({ Target = ..., ... })`; a native
`compute()` process writes the message into `base.results.outbox`.

No request carries a time. The processes use the scheduler's time, and the
scheduler refuses a second copy of a signed message.

## How results arrive

- **Processes** get a pushed message. A process is believed only as a
  `from-process` attested by the shared scheduler, so check that the push comes
  from the process you asked (`rng.handle(msg, from)` does this).
- **Wallets** get nothing pushed (a push to a wallet stalls the node's
  delivery). A wallet reads its value from the published round record.

Every value can be rechecked from published data:

| Tier | Request value |
|---|---|
| Fast | `SHA-256("hyperbeam/rng/fast/v2/request|" round_value "|" requester "|" request_id)` (the round's `derivation` field names the rule) |
| Any-Honest | `SHA-256("hyperbeam/rng/any-honest/v1/request|" round_value "|" requester "|" request_id)` |
| Subscription | `SHA-256("hyperbeam/rng/subscription/v1|" round_value "|" subscription_id "|" round)` |

`lib/js/derive.ts` (`fastRequestValue`) and `lib/js/fair-client.ts`
(`requestValue`, `findRequest`) compute them.

## Local

Free, immediate and replayable. Use it only where the sender knowing the
result first is harmless.

```lua
local rng = require("rng")              -- lib/rng.lua

-- Seed math.random for this message (deterministic on every replay):
rng.install(msg)
local roll = math.random(1, 6)

-- Or a named continuation, run before rng.request returns:
rng.on("Roll", function(stream, ctx) grant(ctx.player, stream:int(1, 6)) end)
rng.request(msg, { tier = "local", on = "Roll", ctx = { player = msg.From } })
```

The seed is the process id, message id, slot, timestamp and a per-message
counter, so two calls in one message differ.

## Prepaid balances

The Fast tier, the Any-Honest beacon and fair play each keep their own
balances. You fund one with a token Transfer to that process; the token sends
it a `Credit-Notice` carrying your `X-` tags.

```text
Target: n7snPbrtwBA4LIlYMHHavzSZSrbUmheSLhw1uuX-KSY      (the RNG token)
Action: Transfer
Recipient: <Fast, Any-Honest or fair process>
Quantity: <atoms>
X-For: <account to credit>                                optional; default the sender
```

- Fast and Any-Honest credit whole RNG. Atoms below one RNG come back to the
  sender, and so does a transfer that credits nothing.
- Fair play credits atoms to a game (`X-Fair-Game` or `X-For`). A new game
  account needs at least one request price, or the transfer comes back.
- **Pay at deposit.** A balance is up to 8 batches, each at the prices in
  force when it was credited. A request pays the price of the oldest batch
  that covers it, so a later price change never reaches credit already bought.
  A deposit at a ninth price is refunded (`Too-Many-Price-Batches`).
- **Withdraw** at any time, paused or not, newest batch first:
  `Action: Withdraw` to the Fast or Any-Honest process, with an optional
  `Quantity` in whole RNG (default: all). Fair play:
  `Action: Fair.Withdraw, Nonce: <n>, Quantity: <atoms>` (see below).
- Balances: Fast publishes `beaconstate.balances[<account>]`. The Any-Honest
  beacon answers `Action: Balance, Account: <account>` in its reply, and every
  `Request-Random` reply carries the new `balance`.

The intended pattern: the application's process holds the balance and pays
for its users, so players never hold RNG.

## Fast

On demand: a round exists only when a paid request waits for it. The request
binds to the next unsigned round (the one after, if that round is already
locked by its first partial signature).

**From a wallet, in one message (pay and request).**

```text
Target: n7snPbrtwBA4LIlYMHHavzSZSrbUmheSLhw1uuX-KSY
Action: Transfer
Recipient: NBpbTl643CXrRx3IIbN712O2_ZXbhbbFJZZhlcmOTsY
Quantity: 3000000                     price x unit; read beaconinfo first
X-Request-Id: <1-128 characters, unique for you>
```

The Credit-Notice credits the sender and runs `Request-Random` for it in the
same slot, at today's price. `X-For` is ignored here: the payer is the
requester. Then:

1. Read the round from `beaconstate.seen["<wallet>|<request id>"]`.
2. Once `beaconinfo.round` reaches it, read the round record:
   `beaconstate.rounds["<round>"]` (the last 32), or older rounds at their slot
   through `beaconhistory`.
3. Your value is the Fast request value above, over the round's `value`. Check
   the round with the group key: BLS signature over
   `hyperbeam/rng/v1|NBpbTl643CXrRx3IIbN712O2_ZXbhbbFJZZhlcmOTsY|<round>`,
   and `value = SHA-256("hyperbeam/rng/v1/round|" message "|" signature)`.

If the request is refused (paused, for example), the RNG stays in your Fast
balance; `Withdraw` takes it back.

**From a process, against its balance.**

```text
Target: NBpbTl643CXrRx3IIbN712O2_ZXbhbbFJZZhlcmOTsY
Action: Request-Random
Tier: fast                            optional; "beacon" is the old name
Request-Id: <1-128 characters>
```

The reply is `{ requestId, round, price, balance }`. When the round is signed
the process receives:

```text
Action: RNG-Result
Data: { "round": 12, "signature": "<hex>", "derivation": "hyperbeam/rng/fast/v2/request",
        "results": [ { "requestId": "<id>", "round": 12, "value": "<hex>" } ] }
```

With `lib/rng.lua`:

```lua
rng.config({ fast = "NBpbTl643CXrRx3IIbN712O2_ZXbhbbFJZZhlcmOTsY",
             anyHonest = "98AkinkWAtW2NM-csO-D1GNI-lJqf3xWbX-TgeupWUM" })
rng.handlers(Handlers)                 -- aos: routes RNG-Result to rng.handle
rng.on("Loot", function(stream, ctx, info) grant(ctx.player, stream:int(1, 100)) end)
rng.request(msg, { tier = "fast", on = "Loot", ctx = { player = msg.From } })
```

`tier = "any-honest"` asks the Any-Honest beacon the same way. A result
resolves only when it comes from the process the request went to. The old
`beacon` config key and tier name still mean Fast.

A round still unsigned 30 minutes after its oldest request is abandoned and
refunded in full; a requesting process gets
`Action: RNG-Error` with `{ "error": "Round-Abandoned", ... }`.

## Any-Honest

Each request binds to the round taking commits, whose outputs nobody can know
yet. Rounds finalize in under 30 seconds while validators keep up; a withheld
output is cracked, which takes longer.

**From a wallet, in one message (pay and request).**

```text
Target: n7snPbrtwBA4LIlYMHHavzSZSrbUmheSLhw1uuX-KSY
Action: Transfer
Recipient: 98AkinkWAtW2NM-csO-D1GNI-lJqf3xWbX-TgeupWUM
Quantity: 4000000                     priceSchedule.request x unit
X-Request-Id: <1-128 characters>
```

`payAndRequestTags(beacon, atoms, requestId)` in `lib/js/fair-client.ts` builds
these tags. The finalized round record lists every request with its value, so
the wallet reads `beaconround-0` ... `beaconround-7` (round `r` is in
`beaconround-<r % 8>`) and finds its own entry:

```text
{ "round": 812, "value": "<round value>", "requests": [
  { "requester": "<wallet>", "requestId": "<id>", "value": "<your value>" } ], ... }
```

`findRequest(records, wallet, requestId)` finds it and rechecks the value.
Rounds older than the last 8 are read at their slot through `timelockhistory`
(`findAnyHonestRound` in `site/lib/rng.ts`).

**From a process, against its balance.**

```text
Target: 98AkinkWAtW2NM-csO-D1GNI-lJqf3xWbX-TgeupWUM
Action: Request-Random
Tier: any-honest                      optional; "timelock" also accepted
Request-Id: <1-128 characters>
```

The reply is `{ requestId, round, price, balance }`. On finalize the process
receives:

```text
Action: RNG-Result
Data: { "round": 812, "tier": "any-honest", "value": "<round value>",
        "results": [ { "requestId": "<id>", "round": 812, "value": "<hex>" } ] }
```

With `lib/rng.lua`, `rng.request(msg, { tier = "any-honest", on = ... })`
sends this and `rng.handle` resolves the result (see Fast above). Without it,
accept the result only from the Any-Honest beacon (its attested
`from-process`) and match `results[].requestId` to your requests.
`protocol/test/request-consumer.lua` is a minimal native consumer.

If a pay-and-request is refused, the credit stays in your beacon balance.

A request id is remembered for 10 minutes (scheduler time); a resend within
that is answered `{ duplicate = true }` and not charged again.

**Subscriptions (processes only).** One message buys a value every round:

```text
Target: 98AkinkWAtW2NM-csO-D1GNI-lJqf3xWbX-TgeupWUM
Action: Subscribe
Subscription-Id: <1-128 characters>
Rounds: <1 to 31,536,000>             default: subscriptionRounds (1,000)
```

It costs `subscription` RNG per `subscriptionRounds` rounds (1 RNG per 1,000),
from the process's balance. At most 16 live subscriptions per process. Every
covered round sends:

```text
Action: RNG-Subscription
Data: { "round": 813, "tier": "any-honest", "roundValue": "<hex>",
        "results": [ { "subscriptionId": "<id>", "round": 813, "value": "<hex>" } ] }
```

`protocol/test/subscription-consumer.lua` is the live test consumer
(`qxYgg3GQ0Tl4kwDAk3azOoWjHgK5upvk9-OeVjjgz2c`).

**Errors.** A refusal is the reply's `{ "error": ... }`; a process also gets
`Action: RNG-Error` with the same Data. Codes include `Insufficient-Balance`,
`Missing-Request-Id`, `Tier-Unavailable`, `Paused`, `Too-Few-Validators`,
`Not-Configured` and, for subscriptions, `Process-Required`,
`Too-Many-Subscriptions` and `Bad-Rounds`. An abandoned round refunds each
request at the price it paid and sends `RNG-Error` `Round-Abandoned`.

## Fair play for games

The player's browser is one more honest party. It commits to a secret before
the beacon value exists and reveals it after, so the game, the fair process
and every validator together still cannot predict the outcome.

**1. The game prepays** (any game may play):

```text
Target: n7snPbrtwBA4LIlYMHHavzSZSrbUmheSLhw1uuX-KSY
Action: Transfer
Recipient: zEI8l8oaThgvIzd60ZyioW6TLZR10yKoeMTgp56TopE
Quantity: <atoms, at least one request price>
X-Fair-Game: <the game's wallet or process id>
```

`fairFundTags(fair, game, atoms)` builds it. The balance is in
`fairaccounts[<game>]` as `{ balance, reserved, nonce }` (atoms).

**2. The game opens a session** for the player's browser key:

```text
Target: zEI8l8oaThgvIzd60ZyioW6TLZR10yKoeMTgp56TopE
Action: Fair.Open
Session: <1-64 of A-Z a-z 0-9 _ - . :>
Player: <the browser key's address>
```

It reserves one request price, or is refused `Game-Unfunded`. The allowance
lasts 10 minutes. `FairClient.player()` gives the key's address.

**3. The browser commits** a fresh 32-byte secret `s`, signed by its own
key:

```text
Action: Fair.Commit
Game: <game>
Session: <session>
Commit: SHA-256("rng/fair/v1/commit|" game "|" session "|" s)
```

`FairClient.commit(game, session)` saves `s` (IndexedDB) before sending and
retries `Not-Opened` while the game's `Fair.Open` is on its way.

**4. The fair process** batches commits, keeps one Any-Honest request
outstanding and, when the beacon value `v_b` arrives, gives each session
`v = SHA-256("rng/fair/v1/beacon|" v_b "|" game "|" session)` and a deadline
`revealBy` (now + `fairWindowMs`, 60 s). The session's status in
`fairsessions[<game>]` becomes `reveal-due`.

**5. The browser reveals** before `revealBy`:

```text
Action: Fair.Reveal
Game: <game>
Session: <session>
Secret: <s, 64 hex>
Player: <the browser key's address>   optional; default the signer
```

`final = SHA-256("rng/fair/v1/final|" v "|" s)`. With no reveal by
`revealBy`, anyone sends `Action: Fair.Expire, Game, Session, Player` and
`final = SHA-256("rng/fair/v1/forfeit|" v)`. **Score a forfeit as the worst
outcome**, or a player can withhold a losing reveal.

**6. The result.** A process game (one whose `Fair.Open` came from a process)
receives:

```text
Action: Fair-Result
Session: <session>  Player: <player>  Status: revealed | forfeit
Final: <hex>        Round: <beacon round>
Data: <the session view, JSON>
```

A wallet game reads `fairsessions` (unresolved sessions plus the last few
resolved), then `fairhistory` for older ones (`FairClient.history`).
`verifySession(view)` in `lib/js/fair-client.ts` rechecks every hash.

**Price.** The batch's one request price (4 RNG) is split over its sessions;
the rest of each session's reserve is freed. A game takes its free balance
back with:

```text
Action: Fair.Withdraw
Nonce: <greater than the last one used>
Quantity: <atoms>                     optional; default all free balance
```

A game can embed `lib/fair.lua` instead of using the fair process, and skip
the hop.

## For agents

- `/llms.txt` indexes these docs; `/llms-full.txt` is all of them as one file.
- Every page is also plain markdown at `/docs/<slug>.md`.
- `POST /mcp` has tools to list, read and search these docs, and
  `rng_request_templates`, which returns the live ids, prices and every
  message above as a template.
