# Any-Honest v3: permissionless, DAO-governed

Status: spec, feasibility and build plan, kept as the design record; "Governance at
launch" is current and implemented.
Branch `permissionless`, based on v2 at `ff06740` (beacon `MZMoXv-2`).

## Summary

- An RNG-staked instance of YapDAO (`stake-dao/1`) is the only owner of the beacon, fair
  play and the fast tier once the launch wallet renounces. **YapDAO needs no code
  changes.** The protocols read governance parameters from tags, make the DAO's money and
  code actions wait at least 24 h (`Effective-At`), open an exit hatch while they wait,
  and accept the DAO through the scheduler-attested `from-process` check they already
  use for the token's `Credit-Notice`. See "Governance at launch".
- The RNG token gets a fixed supply minted once at genesis. It has no faucet and no
  mint, and no admin power over balances. It adopts `sequenced-v1` (rune.lua) because
  the DAO deploy and the Paralith vault both require it.
- Validators join by bonding: a Transfer with `X-Bond` of at least `stake` creates the
  registry entry. There is no `Admin.Add-Validator` and no `Admin.Reinstate`. Each round
  takes at most `maxActive` validators, ranked by capped bond, then seniority.
- When the reserve runs out, the beacon switches to request-driven rounds instead of
  halting. A request that can never be served is refunded.
- A new "fair play" flow lets a player's browser commit a secret before the beacon value
  is bound. The result is final = H(beacon value, player secret), so an honest player
  knows the outcome is fair even if every validator and the game colluded. The flow
  runs as a separate process (or embedded library) and costs the beacon one request per
  batch.
- Third parties need only the JS validator, a wallet and RNG for the bond. The
  HyperBEAM fork with `rng-validator@1.0` + `rng@1.0` is optional.

## Governance at launch (2026-11-07, current)

This section is what goes live. Where the design record below says otherwise
(D2, D11, D17, the handler table, T2, T8, T9), this section wins.

### Who owns the protocols

The launch wallet bootstraps: it spawns the token, the DAO, the beacon, fair
play and the fast tier, sends the genesis `Gov.Configure` and the funding
transfers. In the same deploy step (`deploy.mjs dao-handover`, part of
`plan`) it sends `Gov.Set-Dao` and then `Gov.Renounce-Wallet` to the beacon,
fair play and the fast tier, and reads back that each one publishes
`gov.dao = <RNG DAO>` and `gov.wallet = false`. After that the wallet has no
powers. The RNG DAO is the only owner. The launch validators bond only after
this step.

Nothing the wallet set going outlives it. `Gov.Renounce-Wallet` is refused
while `govPending` is not empty (a queued action, or a DAO code approval:
apply or cancel it first), and it clears the wallet's own code approval, so
no wallet-era root can install later. `dao-handover` also refuses unless
every protocol's `govPending` is empty, nothing is approved, `gov.code` /
`gov.version` are the build recorded at spawn, and the DAO publishes
`daoinfo` as `stake-dao/1` on our token with no admin.

### Who governs the DAO

RNG Labs stakes 50,000,000 RNG in the DAO at launch (`LABS_STAKE_RNG`,
`RNG_LABS_STAKE` overrides it). That is the majority of the stake at launch,
so Labs decides votes for as long as no coalition stakes more. The rest of
Labs' allocation stays liquid. The plan is to sell it to the public over time
or move it into the reserve or the treasury, so control spreads as RNG is
sold. Labs can add stake if it needs to.

What that means in numbers. A veto wins when NoWithVeto is above 33.34 % of
all votes, so against Labs' 50 M voting NoWithVeto an outsider needs about
100 M of active stake to pass anything. But quorum is 10 % of the stake: if
Labs does not vote, a proposal needs only that much turnout, about 5.6 M RNG
(~0.56 % of the supply) at launch, and can pass anything. **Labs must watch
and vote on every proposal.** `deploy.mjs dao-watch` lists every open
proposal (flagging any Labs has not voted on) and every pending action on
the beacon, fair play and the fast tier, and exits 1 when one needs a look:
run it at least once per voting period (from cron). Quorum stays 10 %:
raising it would not remove the need to vote (any quorum below Labs' share
still lets a small turnout pass while Labs is absent) and would make the
DAO harder to run as stake spreads.

DAO rules (`daoRules`, stake-dao/1): voting period 1 day (86,400,000 ms; a
vote can raise it but never set it below 1 day), quorum 10 % of the stake,
pass when Yes is above 50 % of Yes + No + NoWithVeto, veto when NoWithVeto is
above 33.34 % of all votes, proposal threshold 25,000 RNG, deposit 5,000 RNG
(lost to a veto), unstake delay 14 days, at most 20 open proposals and one per
proposer.

### Effective-At

Every DAO action may carry `Effective-At` (milliseconds, scheduler time).
Actions that move money or code must carry one at least 24 hours
(`Gov.EXIT_FLOOR_MS`, a constant in `vendor/gov.lua`: no vote can lower it)
after the action arrives; `Gov.Set-Successor` and `Gov.Move-Reserve`, which
move (or name where to move) the 200 M Foundation reserve, at least 7 days
(`Gov.RESERVE_FLOOR_MS`). Harmless actions apply on receipt, or wait for a
later `Effective-At` if they name one.

Every `Gov.*` needs the scheduler's timestamp: one without (or 0) is
refused `No-Time`, one older than the last `Gov.*` seen `Time-Went-Back`.
`Exit-Now` without a timestamp is refused too.

| Process | Harmless: on receipt | Money/code: `Effective-At` >= receipt + 24 h |
|---|---|---|
| Beacon | `Gov.Configure` of `Request-Price`, `Subscription-Price`, `Subscription-Rounds`, `Abandon-After-Ms`, `Catch-Up-Ms`, `Rejoin-Base-Ms`, `Rejoin-Cap-Ms`, `Heartbeat`, `Fair-Window-Ms` (prices <= 1,000,000 RNG), a higher `Max-Active` or `Max-Validators`, a lower `Min-Commits`; `Gov.Pause`; `Gov.Resume`; `Gov.Cancel` | `Gov.Configure` that changes `Stake`, `Slash`, `Commit-Window-Ms`, `Reveal-Window-Ms`, `Crack-Bounty`, `Max-In-Flight`, `Cadence-Ms`, `Target-Interval-Ms`, `Round-Price` or `T` (or names `H`), lowers `Max-Active` (never below 8) or `Max-Validators`, or raises `Min-Commits`; `Gov.Set-Successor` and `Gov.Move-Reserve` (7 days); `Gov.Treasury-Spend`; `Gov.Fund-Reserve`; `Gov.Remove-Validator`; `Gov.Set-Dao`; `Gov.Approve-Code` |
| Fast tier | `Gov.Configure` of `Signer-Fee`, `Protocol-Fee` (<= 1,000,000 RNG each), `Abandon-After-Ms`; `Gov.Pause`; `Gov.Resume`; `Gov.Cancel` | `Gov.Configure` naming the committee (`Committee`, `Share-Public-Keys`, `Group-Key`, `Threshold`, `Verification`); `Gov.Claim-Protocol`; `Gov.Set-Dao`; `Gov.Approve-Code` |
| Fair play | `Fair.Configure` of `Request-Price`, `Fair-Window-Ms`, `Keep`, `Max-Open`, `Min-Interval-Ms`, `Max-Games`, `Max-Per-Game`; `Gov.Cancel` | `Fair.Configure` that names the beacon or token while unset; `Gov.Set-Dao`; `Gov.Approve-Code` |

A value equal to the current one changes nothing and counts as harmless.
Fewer seats per round concentrate who makes the randomness, so lowering
`Max-Active` is money and it has a hard floor of 8: a quarter of the seats go
to the longest-ready incumbents, so at least two are not for sale to the
biggest bonds.

Prices and fees are harmless because of **pay at deposit**: a prepaid
balance (beacon requests and subscriptions, the fast tier, a game's fair-play
balance) is held as batches at the prices in force when it was credited
(`lib/rng.lua` purses, at most 8 price batches per account; a deposit at a
ninth price is refunded). A request or session pays the price of the oldest
batch that covers it, and the validators', signers' and treasury's shares
come from that price, so a raise binds only later deposits and old credits
keep their price forever. A remainder smaller than its batch's price stays
as change, usable when the batch can cover something (a subscription) and
always withdrawable. `Withdraw` returns the unused balance at face, newest
batch first. Pay-and-request (one transfer) pays the price in force at that
moment. An abandoned request comes back at the price it was paid at.
`Gov.Renounce-Wallet` is the wallet's alone and only ever removes power.
`Gov.Apply` is anyone's.

A waiting action is checked against the hard bounds when it arrives and
stored. Each process publishes its queue as `govPending` (id, verb, class,
`effectiveAt`, `expiresAt`, summary) in `beaconinfo` or `fairinfo`. Once it is
due, anyone sends `Gov.Apply Gov-Id=<id>` and the bounds are checked again
(two changes that are legal alone but not together: the second is refused at
apply and stays pending). The DAO drops a pending action with a later
proposal, `Gov.Cancel Gov-Id=<id>`. An action not applied within 14 days after
it was due lapses. `Effective-At` can be at most 90 days ahead, and at most 32
actions wait at once.

The treasury cap (spends plus reserve funding) is a rolling window: the
outflows of the last 30 days plus the new one are at most 10 % of (the
treasury now + those outflows), i.e. of the treasury before them; at most
64 outflows are remembered (`beaconinfo.treasuryWindow`: `used`, `base`,
`remaining`, `nextDropAt`).

Code: `Gov.Approve-Code` records the code root and its `Effective-At`. Anyone
may upload the matching code at once (`Gov.Upgrade`, one message or a
manifest and parts), but it installs only at or after `Effective-At`. Parts
that arrive early are kept; once due, any part or the manifest sent again
installs them. `Gov.Cancel Gov-Id=code` drops the approval, and it lapses 14
days after it was due.

### The exit hatch

From the receipt of a passed money/code action until its `Effective-At`
plus one hour (`Gov.HATCH_GRACE_MS`), unless it is applied, cancelled or
refused at `Gov.Apply` first, `beaconinfo.hatch` (and `fairinfo.hatch`) is
true and:

- A beacon validator may send `Exit-Now`. It is out of every round not yet
  opened, and its bond is refunded in the same message less one
  `crackBounty` for each round it still owes (`beaconinfo.exitHolds`). Its
  seat in those rounds earns nothing, whoever fills it. It is never slashed
  for them. Those rounds run on by the usual rules: its output still counts
  if it reveals, it can be cracked (the treasury pays the bounty and the
  hold repays it), and a round that cannot finish is abandoned and its
  requests refunded. Its own reveal or an abandon releases that round's
  hold; once every owed round has settled the rest comes back in one
  Transfer, and until then the address cannot bond again. So leaving and
  cracking your own rounds earns nothing, and an honest exit gets the whole
  bond back once its rounds settle. Randomness stays any-honest.
- A fast-tier committee member may send `Exit-Now`: it leaves the committee
  and its earnings are paid at once. The fast tier holds no bonds. If fewer
  than `threshold` members remain, rounds are abandoned and refunded.
- Payers withdraw their beacon and fast-tier balances (`Withdraw`) and games
  their free fair-play balance (`Fair.Withdraw`). These work at any time, while
  paused too, hatch or not.

Only a passed DAO action opens the hatch. Nobody else can: a stranger's or
another process's `Gov.*` is refused, and a harmless action waiting for a
later `Effective-At` does not open it. An action left unapplied does not
hold it open past its `Effective-At` plus one hour.

### Treasury cap

Treasury spends and reserve funding together take at most 10 % of the
treasury in any rolling 30 days (see "Effective-At" for the exact rule;
`beaconinfo.treasuryWindow`). The cap is checked when the action is proposed
and again when it applies.

### What this does not protect

- There is no instant emergency fix. The fastest brake is `Gov.Pause`, one
  voting period (1 day). The fastest money or code change is one voting
  period plus the 24 h floor. Validators and payers can always leave at once.
- The hard bounds hold for the code that is running. A code upgrade can
  change the code, bounds included. The protection against a bad upgrade is
  the 24 h floor plus the exit hatch, not the bounds.
- Labs' stake decides votes at launch. The floor and the hatch are what a
  validator or payer relies on if they disagree with a vote.
- A cold restore runs the spawn module, not installed code: resend the
  installed code (deploy/README.md, "Cold restore"); `verify` flags it.

### Future (v4)

Not built; to ship later as an in-place upgrade (Gov.Approve-Code).

- Validator fee marketplace: each validator sets its own fee; a beacon is a
  chosen validator set and pays the sum of its members' fees plus the
  protocol fee; a fee change takes effect only after notice.

Needed changes for v4 (pricing game theory), doc only for now:

1. A validator-set fee marketplace: per-validator fees, a beacon as a chosen
   set, notice before a fee change, and deposit price locks per set.
2. Credits locked forever at their purchase price underpay validators after
   a price rise (stale cheap credits).
3. The fast-tier committee may refuse rounds made only of cheap old credits;
   today such a round is abandoned and refunded after 30 minutes.
4. The reserve-funded heartbeat's economics once fees are set by a market.
5. Labs' DAO majority and the quorum as stake spreads.

## Randomness tiers

| Tier | Process | Safe unless | Speed | Cost |
|---|---|---|---|---|
| **Local** | `~rng@1.0/derive` in your own process | always predictable to the sender | immediate | free |
| **Fast** | `protocol/beacon/beacon.lua` (on-demand threshold BLS) | 2 of the 3 committee operators collude | about one message phase | 3 RNG per request |
| **Any-honest** | `protocol/beacon/anyhonest.lua` (time-lock commit/reveal) | every validator colludes (one honest validator is enough) | slower: commit, reveal (and crack) windows | 4 RNG per request |

Fast sits between bad local randomness and the best any-honest randomness.
It is not a beacon: nothing runs on a clock. A round opens only when a paid
request waits for it, and the three `rng-provider` daemons sign only rounds
with requests. `beacon` stays its internal id (`Tier = "beacon"` or `"fast"`).
A Fast round the committee leaves unsigned is abandoned like an Any-Honest one:
`abandonAfterMs` (default 30 min, `Gov.Configure Abandon-After-Ms`, 1 min to 7 d)
after its oldest request, every request is refunded exactly what it was charged
(to its balance; `Withdraw` pays out on the sequenced-v1 stream), requesting
processes get `RNG-Error Round-Abandoned`, and signers are paid nothing. Once
the value is computable from what was published (threshold partials or a posted
signature) it waits `ABANDON_CAP_MS` (7 d) after the lock instead (no selective
abort). An unlocked round keeps its number; a locked one's number is skipped,
since its deterministic signature may already be public.

## State bounds

Every map is bounded; history is read from the per-slot results
(`<pid>~process@1.0/compute&slot=<n>/<key>`, deploy/README.md "History").

**No user time.** Every time a process uses is its scheduler's: the
timestamp on the message's assignment (`now`). No message carries a time of
its own (`Request-Time`, `Commit-Time`, `X-Request-Time` are gone). Replays
are the scheduler's job: it assigns a signed message at most once per
process and refuses a copy with 409 "Message already scheduled."
(`dev_scheduler_server` `write_assignment`, paralith/v0.11 lineage; the node
must run such a build, deploy/README.md "Launch prerequisites"). The
processes' own windows below are belt and braces. Unsigned messages can be
posted again, so nothing that moves value or opens or commits a session
accepts one.

| Process | Map | Bound | Why a pruned entry cannot be replayed |
|---|---|---|---|
| Fast, Any-Honest | `seen` (request ids) | the last `GUARD_MS` (10 min) of requests, by scheduler time | a copy of the signed request is refused by the scheduler; the same id in a new message within `GUARD_MS` is a duplicate |
| Fast, Any-Honest, fair | `credited` (token refs) | newest 1000 (fair 1024), the rest folded into `creditFloor` | `t<n>` is the token's ever-increasing seq; anything ≤ floor counts as credited (fail-closed) |
| Fast, Any-Honest | `gov.executed` (DAO proposals) | newest 256, numeric ids folded into `executedFloor` | a redelivery follows its first copy; an id ≤ floor counts as run |
| Fast | `rounds` | last 32 (was 256) | — (records stay readable at their slot) |
| Any-Honest | `rounds`, `recent` | last 8 | — |
| Fast, Any-Honest | `pending` | open rounds only; refunded after `abandonAfterMs` | — |
| Fast, Any-Honest | `history` → `beaconhistory` / `timelockhistory` | last 1024 rounds `[round, slot, "abandoned"?]` | — (an index; older: binary search on `beaconinfo.round`) |
| fair | `sessions`, `byGame` | unresolved + last `keep` per game | a session key is single-use while remembered (`Session-Taken`); `done` refuses a pruned key for `GUARD_MS` more; a copy of a signed Open or Commit is refused by the scheduler |
| fair | `batches`, `bound` | last 16 bound | — |
| fair | `history` → `fairhistory` | last 1024 `["session:<g|s|p>" / "batch:<b>", slot]` | — |
| fair | `accounts` (nonce) | one per funded game | `Fair.Withdraw` nonce strictly increases per account; accounts are never pruned |
| token | `TransferReceipts`, `TransferStreams` | 1024 receipts (32 per sender); per sender a floor + 256 window | sequenced-v1: a seq ≤ floor or in the window is a duplicate |
| all | balances, bonds, validators, subscriptions | accounts (economic state, not history); validators ≤ `maxValidators`, live subscriptions ≤ 16 per subscriber | — |

Each slot's own record is enough to check it independently: Fast
`beaconround = { round, message, signature, value, signers, groupKey, requests, slot }`
(BLS-verify, then value = H(round | message | signature)), Any-Honest
`beaconround-<r%8>` (commits, outputs, value, requests, slot), abandons in
`beaconabandoned = [{ round, refunded, slot }]`, fair sessions in the slot's
output (`fair.view`, enough to recompute `final`).

## Decisions (changeable)

| # | Decision | Why |
|---|---|---|
| D1 | No YapDAO changes. Governance actions are one tags-only message per proposal, and the beacon parses its parameters from tags (`Gov-*` names below). | DAO caps fit: 16 tags, values ≤ 512 B, ≤ 2048 B total. An `h`/`hProof` (< N, ≤ 512 hex chars) fits one tag each. |
| D2 | **Superseded again: see "Governance at launch"** (money/code waits Effective-At >= 24 h, exit hatch, treasury cap). Earlier 2026-11-07: no queue or timelock; every owner action applies on receipt (ANY_HONEST.md, Governance). Was: the beacon keeps its own timelock: 10 days (longer than the DAO's 7-day vote) for `Gov.Set-Successor`, `Gov.Move-Reserve`, `Gov.Treasury-Spend`, `Gov.Fund-Reserve` and a `Gov.Configure` of `stake`, `slash`, `commitWindowMs`, `revealWindowMs`, `crackBounty`, `maxInFlight`, `cadenceMs` or `targetIntervalMs`; other Configure parameters apply at once (bounded). A queued action expires 14 days after it is due. There is no guardian: only the DAO cancels, by proposal. | The DAO has no delay (DAO.md:121). A counter-proposal (Gov.Cancel) can pass inside the delay, and a validator can exit before a change to its bond's exposure lands. |
| D3 | The DAO process, the beacon and the RNG token run on **one scheduler** (`hyperbeam.tylerw.ai`, where Paralith also runs) | `from-process` is believed only when *our own* scheduler signed the delivery |
| D4 | Treasury and reserve stay inside the beacon and are never sent to the DAO | The DAO cannot target its staked token (dao.lua:192), so RNG it held would be stuck forever |
| D5 | Fixed supply of 1,000,000,000 RNG at 6 decimals (10^15 atoms < 2^53). Minted once at genesis, all of it to RNG Labs (one allocation; `$DEPLOYER` on testnet), then sealed. | Enclosed economy. A sealed token has no owner to capture. Distribution is by ordinary transfers (D16). |
| D6 | The token is a port of rune.lua's ledger (`sequenced-v1`, `t<n>` references). Every Transfer the beacon makes carries `X-Transfer-Sequence`. | `deploy-dao.mjs` L81-85 and vault.lua:407 refuse other tokens |
| D7 | Join = a single `X-Bond` credit that brings the bond to at least `stake`. A smaller first bond is refunded. The registry holds at most `maxValidators` = 256; when full, a join evicts (refunds) the lowest-ranked entry that never sent Ready and joined at least 1 h ago, and anyone may `Evict-Idle` an entry that has not sent Ready 7 days after joining. | Bounds `beaconinfo` (cost per published key) and spam; registering alone does not hold a seat |
| D8 | Each round takes `maxActive` = 64 validators. `maxActive // 4` seats go by seniority (earliest `readyAt`: ready without a break; a fault or Pause starts it over); the rest by rank: `min(bond, 4·stake)` descending, then `joinedAt` ascending, then address. Operator validators bond 4·stake from day one. | Fresh Sybils cannot push out incumbents at max bond, and bonding alone never buys every seat (see threat T3) |
| D9 | Ready (first time and every rejoin) needs bond + earnings refill ≥ `stake`. `rejoinBond` is removed. | Owner goal: rejoin = top back up to full stake |
| D10 | `Admin.Reinstate`, `Admin.Add-Validator` and `Claim-Protocol` are deleted. `Admin.Remove-Validator` becomes DAO-only `Gov.Remove-Validator`, which always refunds the full bond to the validator. | The DAO cannot take a bond |
| D11 | **Superseded again: see "Governance at launch"** (the wallet bootstraps and renounces at launch; the DAO is the only owner). Earlier 2026-11-07: two equal owners, the wallet until `Gov.Renounce-Wallet` and the DAO named by `Gov.Set-Dao` (paralith-mono `gov.lua`). Was: the deployer wallet is owner until `Gov.Handover`, a one-way switch to the DAO. There is no guardian (owner decision, 2026-11-07). After handover every action, the brake (`Gov.Pause`) included, is a DAO proposal. Every timelock (10 d) is longer than the 7-day vote, so the DAO can always pass a `Gov.Cancel` before a queued action lands. | No privileged wallet after handover. The cost: a pause takes a 7-day vote. Validators can still `Pause`/`Exit` at once, and bonds and balances are never reachable by governance. |
| D17 | **Superseded again: see "Governance at launch"** (committee and fee-share spend wait Effective-At >= 24 h; fees on receipt). Earlier 2026-11-07: the same two owners, committee and fee spend on receipt. Was: the fast tier (`beacon.lua`) is governed the same way: deployer until `Gov.Handover`, then only the DAO's attested `from-process`. Governance sets `Signer-Fee`/`Protocol-Fee` (at once) and the committee (`Committee`, `Share-Public-Keys`, `Group-Key`, `Threshold`, `Verification`: queued 10 d, needs a new DKG ceremony), pauses new requests, and spends the protocol's fee share (`Gov.Claim-Protocol`, queued 10 d). No owner `Claim-Protocol`, no `Configure` outside governance, no mint. | Same trust model as the any-honest beacon; a committee swap is what decides fast-tier safety, so it waits out the timelock. |
| D12 | Fair play is a separate process, `protocol/fair/fair.lua`, built on an embeddable `lib/fair.lua`. Each game chooses one of the two. | It must not slow the beacon. Embedding saves a ~160 ms hop. |
| D13 | Players sign fair-play messages with an ephemeral browser key by default; the wallet is optional | Avoids two wallet popups per game. Fairness needs knowledge of the secret, not identity. |
| D14 | Heartbeat `roundPrice` drops from 3 to 1 RNG. The reserve is 200 M, about 3.2 years at 2 rounds/s. | 3 RNG/round spends 19 % of supply a year |
| D16 | Distribution from RNG Labs, by transfers in the runbook: **250 M under DAO control = 200 M heartbeat reserve (`X-Foundation`) + 50 M treasury (`X-Treasury`), both inside the beacon**; 100 000 RNG to each launch validator, bonded whole (4·stake; `bond-for` does both in one transfer); a later, optional allocation funds Paralith contracts (not at launch). | "250 M to the DAO" cannot mean RNG in the DAO process: stake-dao/1 can never send an action to the token it stakes (dao.lua:193), so it would be stuck. The DAO controls the reserve and treasury through `Gov.*`. 200/50: the reserve pays heartbeat rounds at 2 rounds/s x 1 RNG = 172 800 RNG/day, so 200 M lasts about 1 157 days (3.2 yr); the treasury is DAO-spendable but capped at 10 % per 30 days (5 M at launch) and can top up the reserve (`Gov.Fund-Reserve`), so a captured DAO reaches little at once and the runway can still be extended. |
| D17 | Fair play is open to every game, and each game pays for its own draws from a prepaid balance in the fair process (no allowlist). | An allowlist made the deployer a gatekeeper; a shared beacon balance let any game spend it. |
| D15 | `governance/dao.lua` (advisory) and its tests are deleted. Proposal templates move to `deploy/proposals/*.json` in Exec-Tags form. | Replaced by YapDAO |

## Feasibility verdicts

| Goal | Verdict | Evidence |
|---|---|---|
| 1. YapDAO controls the protocol | **Feasible, zero Yap changes.** One message per proposal, tags only (no Data), fired once in the slot that closes the proposal, with no timelock. None of the names the beacon needs are reserved. | dao.lua:72 caps 16/64/512/2048; reserved list dao.lua:160-174 (`data`, `body`, `x-transfer-sequence`, `x-reference`, `cast`, …); execute dao.lua:597-603. `Action`, `T`, `Successor`, `Quantity`, `Recipient`, `Reveal-Window-Ms` are all allowed. |
| 1a. Multiple messages per proposal | Not needed. A multi-step change is several proposals. `Gov.Configure` takes up to 14 parameters in one message. | — |
| 1b. A DAO cannot move a sequenced token it holds | Real limit (`X-Transfer-Sequence` is reserved), avoided by D4 | rune.lua:1092-1108 |
| 2. The DAO owns beacon and token | **Feasible.** The beacon's `actor()` already returns the attested `from-process` when our scheduler signed the delivery (anyhonest.lua:224-237), and `Credit-Notice` relies on it in production (:658). Paralith uses the same pattern everywhere (dao.lua:262 `sourceProcess`, rune.lua:431, custody.lua:138, hunt.lua:278). **Change needed:** `ownerOnly` uses `provenSigner` (wallet only, :921), so it must use `actor()` with `FromProcess` and `== Governor`. | The token needs no owner after genesis (D5) |
| 2a. Beacon identity weaknesses | Two fixes: (a) beacon `provenSigner` takes the *first* RSA commitment (:196-205). It must refuse mixed signers, like rng-token.lua:109-121. (b) `actor()` returns the scheduler's own address on a scheduler-signed message with no `from-process`. It must return nil, as dao.lua:285-291 does. | — |
| 3. Enclosed RNG economy | **Feasible.** Votes (DAO stake), fees (`requestPrice`, `subscriptionPrice`), slashing and pay are already in RNG. Remove `Faucet` and `Admin.Mint`. | rng-token.lua:370-404 |
| 3a. RNG on the Paralith orderbook | **Blocked in paralith-mono, not here.** The live vault is sealed (`Admin.ListAsset` is refused after `Admin.Seal`, vault.lua:1045; there is no unseal). Listing is owner-signed only, so a DAO cannot list (vault.lua:1029-1035). Route: the next Paralith fresh deploy lists `rng` before Seal, and `deploy-sharded-venue.mjs` spawns pair `RNG/GOLD`. | deploy-sharded-venue.mjs L237-267 |
| 4. Permissionless validators | **Feasible** with the beacon changes below. A non-HyperBEAM operator **can validate with the JS validator alone**: commit is `g^alpha mod N` (BigInt), and reveal verification runs on the beacon's node (`rng@1.0`), not the validator's. It needs a refresh first: it is marked superseded and lacks `Act`, `Pause` and successor-following (anyhonest-validator.mjs:3). Its default `commitWindowMs` of 2000 is stale. | Erlang device: dev_rng_validator.erl:132-293, 486-495 |
| 4a. Audit items | Reinstate bypass (:1058, Ready without stake or standing): delete it. Probe clock skew (validator.mjs:109 samples `localNow − firstCommitAt`, which mixes clocks): fix below. All-suspended alert: `health` field plus a console banner. | — |
| 4b. Reserve empty halts rounds | **Bug confirmed.** With heartbeat on, the first Commit fails `Foundation-Reserve-Empty` (:821), the round never opens, and its pending requests are never abandoned, because `abandon` only covers reveal-phase rounds (:513-527). The fix is below. | — |
| 5. "Become a validator" page | Feasible. A new route `/validators` reads `beaconinfo`. | console app has `/how`, `/try`, `/dao`, `/why` |
| 6. Player as honest actor | **Feasible.** Latency is about 5-15 s per draw, or about 3-8 s when the commit is made ahead of time. Beacon cost is ≤ 1 outstanding `Request-Random` per fair process. | See "Fair play" |
| 7. One-off requests | **Exists:** fund via Transfer → `Request-Random` (price 4) → push to a process, or recompute for a wallet. Gaps: two messages per request, wallet results are not published, requests can get stuck, and there is no faucet-free funding UI. | anyhonest.lua:705-744, 547-567 |
| 8. Economics | Specified below. At small validator counts the stake is small next to pay. That is acceptable because withholding cannot bias a value (time-lock). | — |

## Component specs

### Beacon `protocol/beacon/anyhonest.lua`

**Identity**
- `provenSigner`: return nil when two RSA commitments name different committers.
- `actor`: a scheduler-signed message without `from-process` returns nil.
- New state: `governor` (DAO pid, "" before handover), `gov = { queue = {}, nextId }`. No guardian.
- `isGovernor(msg)`: `FromProcess and actor == Timelock.governor and governor ~= ""`.
- `isDeployer(msg)`: `governor == "" and provenSigner(msg) == Owner` (wallet, pre-handover only).
- `govOnly`: `isGovernor or isDeployer`.

> **Superseded.** Owners and verbs are `vendor/gov.lua`'s (`Gov.Set-Dao`,
> `Gov.Renounce-Wallet`, `Gov.Approve-Code`, `Gov.Upgrade`); `Gov.Handover` is
> gone. Which actions wait, `Gov.Apply`, `Gov.Cancel`, the exit hatch and the
> treasury window are in "Governance at launch" above: the floor is 24 h after
> receipt, not 10 days. The table is kept as the design record.

**Governance handlers.** All read **tags**. Data is used as a fallback only when the deployer signs. Tag names are compared lowercased with `-` and `_` stripped.

| Action | Who | Tags | Effect |
|---|---|---|---|
| `Gov.Handover` | deployer | `Governor` (pid) | refused while anything is queued, or if the governor is the deployer, the beacon or the token; sets governor; the deployer path is off forever. `deploy.mjs handover` also checks the governor publishes a `stake-dao/1` `daoinfo` on our token |
| `Gov.Configure` | gov | any of `T`, `H`, `H-Proof`, `Commit-Window-Ms`, `Reveal-Window-Ms`, `Abandon-After-Ms`, `Min-Commits`, `Max-Active`, `Max-Validators`, `Cadence-Ms`, `Target-Interval-Ms`, `Max-In-Flight`, `Catch-Up-Ms`, `Stake`, `Slash`, `Rejoin-Base-Ms`, `Rejoin-Cap-Ms`, `Heartbeat`, `Round-Price`, `Request-Price`, `Subscription-Price`, `Subscription-Rounds`, `Crack-Bounty`, `Fair-Window-Ms` (≤ 15 per message) | the whole message is checked against the bounds below; `Stake`, `Slash`, `Commit-Window-Ms`, `Reveal-Window-Ms`, `Crack-Bounty`, `Max-In-Flight`, `Cadence-Ms`, `Target-Interval-Ms` are queued 10 d (re-checked at apply), the rest applies immediately |
| `Gov.Set-Successor` | gov | `Successor` | queued 10 d, applied by anyone's `Gov.Apply`; supersedes any queued Set-Successor |
| `Successor-Ack` | the successor process, or one queued to become it (attested) | — | records the ack time; only an ack since the naming Set-Successor was queued counts; acks of a cancelled or replaced successor are deleted |
| `Gov.Move-Reserve` | gov | `Successor` (the successor or a queued one) | queued 10 d; pays only that successor, at apply the applied successor with a current ack; dropped if the successor changed; sends `X-Foundation` to it |
| `Gov.Treasury-Spend` | gov | `Recipient` (not the DAO, the beacon or the token), `Quantity` (atoms) | queued 10 d; spends + reserve funding ≤ 10 % of the treasury per 30-day window (`beaconinfo.treasuryWindow`) |
| `Gov.Fund-Reserve` | gov | `Quantity` | treasury → reserve, queued 10 d, under the same window cap |
| `Gov.Remove-Validator` | gov | `Validator` | as the old Remove: not while committed, full bond refunded |
| `Gov.Pause` / `Gov.Resume` | gov | — | `heartbeat = 0` and `paused = true` (new Request/Subscribe refused) / undo |
| `Gov.Cancel` | gov | `Gov-Id` | drops a queued action (a spend's share of the window comes back) |
| `Gov.Apply` | anyone | `Gov-Id` | runs a queued action whose `at` has passed, until `at + 14 d` (then `Expired`, dropped); an action that can never apply is dropped |

A `Gov.*` from the governor carrying an `X-Dao-Proposal` already seen runs once: a redelivery is a no-op.

On a new beacon, `Successor-Ack` comes from its `Configure`/genesis outbox:
`{ target = predecessor, Action = "Successor-Ack" }`.

**Hard bounds** (checked in `Gov.Configure` and at genesis; replaces :1091-1100)
- `2^27 ≤ T ≤ 2^32` (`minT()` raised from 2^20; the harness keeps 1)
- `10 000 ≤ revealWindowMs ≤ 600 000`; `500 ≤ commitWindowMs ≤ 10 000`
- `revealWindowMs ≤ abandonAfterMs ≤ 7 d`
- `1 ≤ slash ≤ stake / 10`; `stake ≤ 10^7`: a fault takes at most a tenth of the stake
- `1 ≤ crackBounty ≤ slash`: each crack also takes the bounty from the withholder's bond
- `1 ≤ maxInFlight ≤ 8`; `cadenceMs ≤ 60 s`; `targetIntervalMs ≤ 10 min`
- `2 × (1 + maxInFlight) × (slash + crackBounty) ≤ stake`. One incident (from the first fault, which
  suspends the validator, until it is in good standing) can fault only the rounds it already holds: the one
  committing plus at most `maxInFlight` revealing. Each costs a slash plus at most one crack bounty, so an
  incident costs at most half the stake (defaults: 4 × 1 010 = 4 040 of 25 000). No vote can turn
  slashing into confiscation.
- `rejoinBaseMs ≥ revealWindowMs`; `rejoinBaseMs ≤ rejoinCapMs ≤ 30 d`
- `2 ≤ minCommits ≤ maxActive ≤ 128`; `maxActive ≤ maxValidators ≤ 1024`
- every price and the bounty ≥ 1; `heartbeat ∈ {0,1}`
- `token`, `unit`, `self` and `predecessor` are fixed after genesis (`Token-Locked`)

**Validators**
- `Credit-Notice` with `X-Bond`: if `who` is not registered, refuse and refund unless the
  credit makes the bond ≥ `stake` and the registry has room (a full registry evicts its lowest-ranked
  never-ready entry that joined at least 1 h ago, refunded; with none, `Registry-Full`). Register `{ ready = false, joinedAt = now }`. Any remainder below one whole
  RNG in a Credit-Notice is refunded to the sender.
- `Ready`: requires `bond + refill ≥ stake` always (delete `rejoinBond`, :1022). Everything else is unchanged.
- `activeValidators()` → eligible (ready, not exiting, not overdue); `maxActive // 4` by seniority, the rest by D8 rank.
- Subscriptions are deleted once their last round has passed; at most 16 live per subscriber.
- Delete `Admin.Add-Validator`, `Admin.Reinstate`, `Claim-Protocol`, `Admin.Set-Successor`, `Admin.Move-Reserve`, `Configure` (genesis config becomes `Gov.Configure` under `isDeployer`).
- `beaconinfo.validators` lists only active + ready + suspended-with-bond, capped at 128. The full registry goes in one key, `beaconvalidators`, rewritten only when it changes.

**Reserve and stuck requests**
- Commit in `collecting` with heartbeat on and reserve < `roundPrice`: if the round has pending
  requests, open it unsponsored; otherwise fail `Nothing-Pending`. `beaconinfo.mode = "request-driven"`.
- `advance()`: a `collecting` round whose oldest pending request is older than `abandonAfterMs` is
  refunded and notified, the same as `abandon()`.
- A reveal-phase round is abandoned past `abandonAfterMs` (default 30 min) only if some validator in its
  set never committed, or the treasury cannot pay a crack bounty. A complete round waits for its crack, so
  a withholder who has seen the other outputs cannot void a value it dislikes (selective abort). Run at
  least two independent crackers; a crack of T = 2^27 takes minutes.
- Hard cap: 7 days after its reveal deadline any round is abandoned and its requests refunded, so nothing
  hangs forever (the withholder was already slashed at the deadline; a void then costs it a slash and a
  week). Each revealing round in `beaconinfo` carries `abandonable` and `abandonAt`; the cracker works on a
  round until `abandonAt`, not `abandonAfterMs`.
- A late round (past its reveal deadline) no longer counts toward `maxInFlight`: its withholder is
  suspended and in no newer round, so a stuck round does not throttle new ones.
- A handler that throws leaves no partial state on either device: the state is deep-copied before each
  handler (all but the `seen` guard, whose changes are journaled and undone) and put back on an error.
  Measured in the test harness at about 2 ms per message for a 35 KB state (≈ 7 % of a message there).
- Before genesis no token is known, so a `Credit-Notice` cannot be credited. It is refunded to `Sender`
  by a `Transfer` to the attested process that sent it (a fake token moves nothing), on a
  per-sender `X-Transfer-Sequence` stream; genesis continues the named token's stream and counts the
  refunded references as credited. At most 16 senders and 256 references each; past that the atoms
  strand, so the deploy script still never transfers before genesis.
- `health = { status = ok|degraded|halted, active, eligible, minCommits, since }`.
  It is `halted` when eligible < minCommits.
- `beaconinfo.at = now` (scheduler time of this slot), for clock offset estimates.

**One-off requests**
- `Credit-Notice` with `X-Request-Id`: credit `Sender`, then run
  `Request-Random` for `Sender` in the same slot (one user message). On refusal the credit stays in the balance.
- The finalized round record `beaconround-<r%8>` gains `requests = [{ requester, requestId, value }]`
  (only for this round's requests), so wallets read their value directly.

**Token payouts:** `transferAtoms` adds `X-Transfer-Sequence = <Timelock.transferSeq + 1>`.
The counter only increases and never resets, as in dao.lua's payouts.

### Token `protocol/token/rng-token.lua`

- Name `RNG`, ticker `RNG` (`TEST-RNG` on testnet), Denomination 6.
- Genesis: `GenesisAllocations = { [addr] = atoms, ... }` is injected by the deploy prelude, minted on the first slot
  only when `Minted == 0`, and must sum to exactly 10^15 or the process refuses every action. Then `Sealed = true`.
- Delete `Faucet`, `Admin.Mint`, `faucetView` and the faucet state. Keep `Admin.Checkpoint` (deployer, harmless).
- Port rune.lua's process-transfer streams: process senders must send `X-Transfer-Sequence`, which is deduped in a 256 window
  (rune.lua:1086-1161). Publish `tokeninfo.ProcessTransferProtocol = "sequenced-v1"`.
- `Credit-Notice` keeps `Sender`, `Quantity`, `Reference = t<n>`, and forwards `X-*` tags.

### YapDAO instance (no code change, deploy only)

- `deploy-dao.mjs` in the yap repo with `RUNE_TOKEN=<RNG pid>` (it is generic over `Dao-Token`, dao.lua:458-465). Rules:
  `Dao-Name = RNG DAO`, threshold 25 000 RNG, deposit 5 000, voting period 1 d,
  quorum 1 000 bps, pass 5 000, veto 3 334, unstake delay 14 d, 20 open proposals.
- Proposal templates (`deploy/proposals/*.json`) hold `{ title, body, execProcess, execTags }`,
  e.g. `{ "Action": "Gov.Configure", "Request-Price": "4" }`; money/code templates carry
  `"Effective-At": "$EFFECTIVE_AT"`, which `dao-propose` fills with the vote's end + 24 h + 1 day.

### Fair play `lib/fair.lua` + `protocol/fair/fair.lua`

| Step | Message | Signed by | State |
|---|---|---|---|
| 1 | `Fair.Commit { Game, Session (≤64), Commit = hex sha256("rng/fair/v1/commit|"‖Game‖"|"‖Session‖"|"‖s) }` | player key P | session `committed`, joins `batch[next]` |
| 2 | fair → beacon `Request-Random { Request-Id = "fair-<b>" }` | fair (attested) | sent when no request is outstanding; otherwise waits for the current result |
| 3 | beacon → fair `RNG-Result` (value v_b) | beacon (attested, checked `== beacon`) | each session gets `v = H("rng/fair/v1/beacon|"‖v_b‖"|"‖Game‖"|"‖Session)`, status `reveal-due`, `revealBy = now + fairWindowMs` (60 s). The next batch's request goes out in the same slot. |
| 4 | `Fair.Reveal { Game, Session, Secret = s }` | anyone | checks the hash; `final = H("rng/fair/v1/final|"‖v‖"|"‖s)`; `Fair-Result` → Game (a process game only) |
| 5 | `Fair.Expire { Game, Session }` after `revealBy` | anyone | `final = H("rng/fair/v1/forfeit|"‖v)`, status `forfeit` → Game (a process game only) |

- `Fair-Result` goes only to a game whose `Fair.Open` came from a process our scheduler attests. A node
  cannot push to a wallet, and a wallet target stalls the slot's whole outbox (the next beacon request
  with it), so a wallet game reads its results from `fairsessions` / `fairhistory`.

- Published: one key `fairsessions` holding the last N per game (bounded), plus `fairbatches`.
  The player checks its own `Commit`, bound round and inputs, then recomputes `final`.
- **Any game may play; each pays for its own draws (D17).** A game (or anyone for it) funds its balance
  with a token `Transfer` to the fair process carrying `X-Fair-Game = <game>` (or `X-For`; default the
  sender). Only a `Credit-Notice` from the configured token, attested by our scheduler, credits; each
  `t<n>` reference counts once; a new balance below one request price, or one for a non-address, is
  refunded to `Sender`. Balances (`fairaccounts`: free `balance`, `reserved`) are kept apart from the
  session registry, so LRU eviction never loses one.
- `Fair.Open` reserves one request price (`requestPrice` × unit atoms) or is refused `Game-Unfunded`
  (before it takes a registry seat). An allowance that lapses unused gives its reserve back. When a
  batch is bound, its request price is split over its sessions in atoms (key order; the first
  `price mod n` pay one atom more), each share capped at that session's reserve, so no balance goes
  negative; the rest of each reserve is freed. A refused or abandoned request charges nobody.
- The beacon is paid from the fair process's **own beacon balance**, because `pay-and-request` treats
  the payer as a wallet and sends it no `RNG-Result`. The deployer funds a small float once
  (`fund-fair 40` = 10 requests; at least 2, since the next batch can go out before the last top-up
  lands). After each bound batch the fair process sends exactly what the games paid to the beacon
  (`Transfer`, credited to its balance, whole RNG; atoms below one wait in `surplus`), so the float is
  never spent. `requestPrice` is configured to the beacon's and must follow a governance change of it.
- `Fair.Withdraw { Nonce [, Quantity] }` from the game pays its free balance back. `Nonce` must exceed
  the last one used, so a redelivered withdrawal pays nothing. Every Transfer the fair process sends
  (top-up, refund, withdrawal) carries the next `X-Transfer-Sequence` of its own stream; a failing
  handler rolls the state back, so it takes no sequence number.
- At `maxGames`, a new game evicts the oldest idle one. The scan drops lapsed allowances first, so
  throwaway games that never open again do not hold the registry.
- Embedded mode: a game process calls `fair.commit/onResult/reveal/expire` on its own state and
  handles Fair.* in its own handler table. This saves the hop. Unmetered: the game pays its own beacon balance.
- Browser: `lib/js/fair-client.ts` creates an RSA-PSS key with WebCrypto once (kept in IndexedDB),
  draws s with `crypto.getRandomValues(32)`, signs ANS-104 with the vendored client, and stores s
  until it reveals (it re-reveals after a reload).

### Validators (what a third party runs)

| Option | Run | Needs |
|---|---|---|
| A (simplest) | `node validator/anyhonest-validator.mjs init && … run` (after WP4) | Node 22, a wallet created by `init`, the beacon pid, the scheduler URL, ≥ `stake` RNG; secrets dir on durable disk; RTT < `commitWindowMs/2` |
| B | HyperBEAM fork node with `rng-validator@1.0` (`on.start` hook) + `rng@1.0` (blst NIF) | the same, plus building the fork |
| optional | `anyhonest-cracker` | CPU; earns `crackBounty` per crack |

Steps: init the wallet → buy RNG → `Transfer { Recipient = beacon, Quantity = stake·10^6, X-Bond = "true" }`
→ the validator sends `Ready` itself (an entry that never does can be evicted) → it works every round in the active set → `Pause` / `Exit` → `Finalize-Exit` refunds the bond.

**Clock-skew fix (both clients):** measure health only from local round trips: post → the commit appears in
`beaconinfo` (local clock both ends). Estimate `offset = min over samples of (localReadAt − info.at)`,
and compare `nextRoundAt` and `rejoinAt` against `localNow − offset`.

### Console `site`

- `/validators`: plain title and body copy (no kicker or hero typography). Sections: requirements,
  four steps with copyable commands, live table (`beaconvalidators`), earnings estimate from live params
  (`roundPrice·rate/active` + request share), risks (slash per missed duty, cooldown doubling, lost secrets
  = a slash per open round, lost wallet = lost bond, DAO parameter changes within the hard bounds).
- Health banner on every page when `health.status ≠ ok`.
- `/try`: remove Faucet. "Get RNG" links to the Paralith RNG/GOLD market. Add one-message pay-and-request.
- `/dao`: replace the advisory console with a link and read-only view of the RNG DAO in Yap (`?dao=<pid>`).

## Security analysis

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | Forged DAO message (a tag claiming `from-process`) | believed only when our scheduler signed it; mixed signers refused | trust in the node operator (true for every AO process) |
| T2 | DAO capture (whale buys > 50 % of staked RNG; at launch Labs holds the majority of the stake) | **Current: see "Governance at launch"**: 1-day vote, ⅓ veto, money/code waits Effective-At >= 24 h with the exit hatch open (validators take their bonds out at once, payers withdraw), treasury ≤ 10 % per 30 days. Design record: 7-day vote, ⅓ veto; 10-day timelock (longer than the vote, so a Gov.Cancel can pass) on successor, reserve, treasury, reserve funding and bond-exposure parameters; treasury outflow ≤ 10 % per 30 days; handover refused over a non-empty queue. **Bonds and user balances are not reachable by governance**: removal refunds in full, a fault takes ≤ stake/10, and slash/stake/window changes land 10 d after the vote, so a validator exits first. | the reserve (via a malicious successor, T9) and ≤ 10 % of the treasury per 30 days, each ≥ 17 days after the proposal, visibly |
| T3 | Sybils fill the active set, then grind the last commit (all validators colluding sets the value) | D8: rank by capped bond, so incumbents at 4·stake cannot be displaced (operators bond 4·stake from day one); a quarter of the seats go by seniority, which bonding cannot buy; consumers needing per-draw guarantees use fair play | an attacker at 4·stake takes up to ¾ of the seats from incumbents below the cap; the whole set only if the senior seats are also its own |
| T4 | Withholding a reveal to bias, or to abort a round after seeing the other outputs | the time-lock makes the value fixed at commit close; crack + slash; a round whose commits are complete is not abandoned while a crack is paid for, until the 7-day cap | delay only; a round short of a commit can still be abandoned after `abandonAfterMs` (30 min, far above the crack time) if nobody cracks; any round after 7 d with no crack |
| T5 | Spam registrations, registry squatting | first bond ≥ stake; registry cap; refund otherwise; a full registry evicts its lowest-ranked never-ready entry, and anyone evicts one idle 7 d | a squatter that does send Ready must then do (or be slashed for) the work |
| T6 | Reserve drained → halt | request-driven fallback, refund of stuck requests | heartbeat consumers see gaps |
| T7 | All validators suspended | `health = halted`, banner, validator logs; requests refunded after `abandonAfterMs` | liveness depends on operators |
| T8 | Slow emergency response (no guardian) | **Current:** a pause is a DAO proposal (1-day vote, on receipt); a money/code fix takes one vote + 24 h; validators and payers leave at once. Design record: a pause is a DAO proposal (7-day vote); every queued action waits 10 d, so the DAO can cancel it first; validators can `Pause`/`Exit` at once; the fast tier's committee change is timelocked the same way | a live bug runs until a vote passes |
| T10 | Fast-tier committee collusion | 2 of 3 operators can predict or choose a fast value; a request binds before the first partial is published; users who need more use any-honest | fast values while 2 operators collude |
| T9 | Malicious successor drains the reserve | **Current:** DAO vote + Effective-At >= 24 h (Set-Successor and Move-Reserve each), exit hatch open meanwhile. Design record: DAO vote + 10-day timelock; Move-Reserve names its successor at queue time and pays only it, with an ack received since it was named; acks of cancelled or replaced successors are deleted; validators' devices only follow a successor naming this beacon | same as T2 |
| T10 | Lost payout (a sequenced transfer never delivered) | the sequence never resets; a `Resend-Payout`-style handler is a follow-up (token window 256) | stalls if > 256 are lost |
| F1 | Player grinds the secret | commit fixed before its batch's request is sent; v_b unknown to anyone until reveals (any-honest) | — |
| F2 | Player withholds the reveal after seeing v (1-bit option) | forfeit is final and games MUST score it as the worst outcome; entry is charged before commit | a game that rewards forfeit is broken by design |
| F3 | Game + all validators collude against the player | they never learn s (256-bit, hashed) → final is uniform to them | none if the player is honest |
| F4 | Player + all validators collude against the game | they can grind v_b knowing s | the game relies on any-honest, as today |
| F5 | Game substitutes a commit | the commit is signed by P; the player checks it in `fairsessions` before revealing | — |
| F6 | Fair-process bloat slows the beacon | ≤ 1 outstanding request per fair process; batch size unbounded | — |
| F7 | A game drains the fair process's beacon balance, or another game's | each game prepays; `Fair.Open` reserves a full request price or is `Game-Unfunded`; a batch charges only its own sessions' games, each share ≤ its reserve; only the token's attested `Credit-Notice` credits, each reference once; `Fair.Withdraw` takes only the caller's free balance, once per nonce | the deployer's float (a few requests) if the beacon raises `requestPrice` before `configure-fair` follows |

## Economics

| Item | Value | Notes |
|---|---|---|
| Supply | 1,000,000,000 RNG, fixed | D5 |
| Genesis | 1 000 M to RNG Labs, one allocation | D5 |
| Distribution | reserve 200 M + treasury 50 M (DAO control, in the beacon); 100 000 per launch validator, bonded; Paralith contracts later | D16 |
| Heartbeat | 2 rounds/s × `roundPrice` 1 = 63.1 M/yr → reserve ≈ 3.2 yr | was 3 → 189 M/yr (the prior audit's ~188.9 M/yr) |
| Request | 4 RNG: 1 treasury, 3 split among contributors | unchanged |
| Subscription | 1 RNG per 1000 rounds → treasury | unchanged |
| Stake | 25 000 | at n=3: ≈ 10.4 h of pay; n=64: ≈ 9.3 days of pay |
| Slash | 1 000 per failed duty → treasury; bound ≤ stake / 10 | n=3: ≈ 25 min of pay; n=64: ≈ 9 h |
| Cooldown | 60 s base, ×2 per incident, cap 1 h; bounds ≥ reveal window, ≤ 30 d | unchanged |
| Crack bounty | 10 from treasury, reimbursed from the withholder's bond | the treasury nets +1 000 per withheld reveal |
| Max-rank bond | 4 × stake = 100 000 | D8 |

Sanity check:
- Pay per validator is `roundPrice·2/n` RNG/s plus request share. Entry is profitable until
  the set fills, so the set self-sizes towards `maxActive`.
- A fault always costs more than the rounds skipped. At n = 64, a round pays 0.016, so a slash equals ~64 000 rounds.
- A validator that cannot hold `commitWindowMs/2` RTT loses ≈ 1 000 per incident. Its client refuses Ready
  until it is healthy.
- After the reserve is spent, validators live on requests: 3 RNG/request ÷ n. Beacons with few requests then shrink,
  which is the intended endgame. The DAO can re-fund via `Gov.Fund-Reserve` from slashes and fees.
- Atoms stay below 2^53 at full supply. `int()` narrowing is required on every tag.

## Build plan

Work packages with disjoint files. The interfaces they share are this document's
message formats. WP1, WP2, WP3 and WP4 run in parallel; WP5-WP8 follow.

| WP | Scope | Files (only these) | Tests to add |
|---|---|---|---|
| WP1 | Beacon v3: identity fixes, Gov.* + timelock (no guardian), permissionless bond/Ready, active-set ranking, bounds, reserve fallback, stuck-request refund, health/at, pay-and-request, round `requests`, `X-Transfer-Sequence`, registry key | `protocol/beacon/anyhonest.lua`, `protocol/test/anyhonest_test.lua`, `protocol/test/run-anyhonest-tests.mjs` | DAO-attested Configure accepted; wallet/forged `from-process`/mixed-signer refused; deployer locked out after Handover; each bound rejected; timelock not before `at`; Move-Reserve needs ack; treasury 10 % cap; no guardian; bond < stake refunded; registry full; Ready needs full stake; ranking + maxActive; reserve empty → request-driven; stuck collecting refund; pay-and-request one slot; `requests` in round record; sequence strictly increasing; Reinstate/Add/Claim gone |
| WP2 | Token: genesis + seal, no faucet/mint, sequenced-v1 | `protocol/token/rng-token.lua`, `protocol/test/token_test.lua`, `protocol/test/run-token-tests.mjs` | genesis sum ≠ supply refuses everything; mint once only; Faucet/Mint unknown; process transfer without sequence refused; replay within/after window; `tokeninfo` publishes protocol; restore never lowers counters |
| WP3 | Fair play lib + process | `lib/fair.lua`, `protocol/fair/fair.lua`, `protocol/test/fair_test.lua`, `protocol/test/run-fair-tests.mjs` | commit before request; one outstanding request; batch carry-over; RNG-Result only from the beacon; reveal hash mismatch; expire before/after `revealBy`; forfeit value; domain separation; bounded `fairsessions`; unfunded game; forged/replayed Credit-Notice; drain attempts; pro-rata rounding; withdraw replay; refund on expiry; eviction keeps balance; rollback takes no sequence |
| WP4 | JS validator parity + skew fix | `validator/anyhonest-validator.mjs`, `validator/anyhonest.mjs`, `validator/test/validator.test.mjs` (new) | Act batching; Pause/Exit; successor follow (needs ack); bond command sends X-Bond; Ready gated by local-RTT health; skewed clock (±60 s) neither false-healthy nor stuck; defaults read from `beaconinfo.params` |
| WP5 | Erlang device parity (repo `hyperbeam-rng-validator`) | `src/preloaded/node/dev_rng_validator.erl`, its eunit file, `docs/devices/rng-validator-at-1-0.md` | skew-free health; full-stake Ready; `health` read; successor ack check |
| WP6 | Console: validator page + health banner | `site/app/validators/page.tsx`, `site/components/validator-guide.tsx`, `site/components/health-banner.tsx`, `site/components/site-header.tsx`, `site/app/layout.tsx` | render with mocked `beaconinfo` (ok/halted); earnings math unit test |
| WP7 | Console: try/dao/fair client | `site/components/try-console.tsx`, `site/components/dao-console.tsx`, `site/lib/rng.ts`, `lib/js/fair-client.ts`, `site/app/api/dao/**`, `site/examples/fair-demo/**` | no faucet path; pay-and-request message shape; fair client commit/reveal hashes match `fair.lua` vectors; IndexedDB loss → forfeit shown |
| WP8 | Deploy + governance + docs | `deploy/deploy.mjs`, `deploy/README.md`, `deploy/test/deployment-config.test.mjs`, `deploy/proposals/**` (delete `dao.lua`), `protocol/test/dao_test.lua` + `run-dao-tests.mjs` (delete), `docs/ANY_HONEST.md`, `docs/SPEC.md`, `docs/PRODUCT.md` | genesis prelude sums; same-scheduler check for token/beacon/DAO; proposal templates valid against DAO caps + reserved names |
| WP9 | Paralith listing (paralith-mono, separate session, later) | `deploy-sharded-venue.mjs` asset list + pair config | RNG deposit/withdraw e2e on a fresh vault |

## Launch plan (testnet)

1. **Build and test**: WP1-WP8 green; `node backend/native/e2e.mjs`-style signed run against the real node for DAO→beacon.
2. **Deploy token** (genesis: 100 % to RNG Labs) on the beacon's scheduler. Verify the supply and `sequenced-v1`.
3. **Deploy the RNG DAO** with `deploy-dao.mjs` (Dao-Token = RNG). Verify `daoinfo` and the same `scheduler-location`.
4. **Deploy beacon v3** with deployer `Gov.Configure` (token, unit, self, predecessor = MZMoXv-2, params, h). Labs funds the reserve (200 M) and treasury (50 M) under DAO control (`X-Foundation`, `X-Treasury`; D16).
5. **Validators bond**: each launch validator gets 100 000 RNG bonded (`bond-for`), then third parties bond at least `stake` themselves. Soak for 72 h with deployer ownership.
6. **Old beacon**: `Admin.Set-Successor` (v2 wallet path). Devices follow once v3 acks. The old TEST-RNG reserve cannot move: it is a different token, so it stays and is retired.
7. **Handover**: deployer `Gov.Handover { Governor = DAO }` on the beacon and on the fast tier. Prove it with a DAO proposal that re-sets one parameter to its current value and confirm `executed` plus the beacon's applied rev.
8. **Market**: Paralith fresh deploy lists RNG and seeds RNG/GOLD (WP9).

**Rollback**
- Before step 7: deployer `Gov.Pause` or reconfigure. Consumers re-point to MZMoXv-2 (it keeps running until retired).
- After step 7: the DAO pauses by proposal (`009-pause.json`, 7-day vote). The fix is a new beacon voted in via `Gov.Set-Successor` (10 d). Validators can `Pause`/`Exit` at any time, and bonds are never at governance risk.

## Open questions for Tyler

1. RNG Labs holds the unallocated ~750 M after distribution, which would control the early DAO quorum if staked. Should RNG Labs not vote?
2. Active-set cap 64 ranked by capped bond + seniority, or uncapped (stronger any-honest, but slower rounds as the set grows)?
3. ~~Guardian pause for 90 days after handover?~~ Decided 2026-11-07: dropped. The DAO acts only through proposals.
4. Market: RNG/GOLD, RNG/RUNE or both. This needs a Paralith fresh deploy, since the live vault is sealed. Who seeds liquidity?
5. Heartbeat subsidy: `roundPrice` 1 (≈ 3.2-year reserve) or keep 3 (≈ 1 year)?
