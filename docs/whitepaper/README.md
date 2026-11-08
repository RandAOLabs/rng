# RNG v3: verifiable randomness for AO

RNG Labs, a CipherPlay Inc. product. Version 3, 8 November 2026, describing the
processes live on AO mainnet (ids in [`deploy/v3-mainnet.json`](../../deploy/v3-mainnet.json)).
Every number below was checked against the code; file references are in
[Appendix A](#appendix-a-sources). Where an older design document says something
else, the code wins ([Appendix B](#appendix-b-where-other-docs-disagree-with-the-code)).

Diagrams: [ARCHITECTURE.md](../ARCHITECTURE.md). Earlier editions:
[`../paper/`](../paper/) (v2) and [`../whitepaper-v1/`](../whitepaper-v1/) (v1).

## 1. Summary

RNG gives AO processes randomness at three strengths. Local randomness is free
and deterministic. The Fast tier signs a value with a 2-of-3 threshold BLS
committee, on demand. The Any-Honest beacon runs a commit-reveal of RSA time-lock
puzzles among bonded validators: if one validator in a round is honest, nobody
could predict or steer that round's value. Fair play adds the player's own secret,
so the player needs to trust nobody at all.

v3 makes the system open and owned by its stakers. Anyone can validate by
bonding 25,000 RNG. The RNG DAO is the only owner of the beacon, the Fast tier
and fair play; the launch wallet renounced. Every governance action that moves
money or code waits at least 24 hours after the vote, and while it waits
validators and payers can leave. The RNG token has a fixed supply of
1,000,000,000, minted once. Prices bind at deposit, so a price change never
reaches credit already bought.

## 2. The problem

HyperBEAM sandboxes `math.random` and `os.time` for AO processes: a draw seeded
by a node's own generator or clock differs between nodes and on replay, and
whoever picks the seed can steer it. Processes still need randomness for
loot, matchmaking, lotteries and games. The randomness must be the same on
every replay, unknown to everyone until it is fixed, and checkable afterwards
from published data alone.

## 3. Tiers

| Tier | Process | Safe unless | Latency | Price |
|---|---|---|---|---|
| Local | `lib/rng.lua` in the caller | always predictable to the sender | none | free |
| Fast | Fast tier `NBpbTl64…` (`beacon.lua`) | 2 of the 3 committee operators collude | one message phase | 3 RNG |
| Any-Honest | beacon `98AkinkW…` (`anyhonest.lua`) | every validator in the round colludes | commit 5 s + reveal, under 30 s; longer if cracked | 4 RNG |
| Fair play | `zEI8l8oa…` (`fair.lua`) or `lib/fair.lua` embedded | never, for an honest player | a beacon round plus the player's reveal | 4 RNG per batch, split |

`rng.install(msg)` gives a process a deterministic stream seeded from the
message. `rng.request(msg, { tier = ... })` asks a tier for a value and calls
the named handler when it arrives. The node's `~rng@1.0` device does the heavy
checks: `verify-reveal`, `verify-crack` (Wesolowski), `verify-bls` and `derive`.

## 4. Any-Honest beacon

### 4.1 Puzzles

All puzzles live modulo N, the RSA-2048 challenge number, whose factorisation
(and so group order) nobody knows. The generator is
`g = (expand("rng/timelock/g", 2112) mod N)^2 mod N`. The delay is `T = 2^27`
squarings; `h = g^(2^T)` is set with a proof that the device checks.

- **Commit.** A validator draws a secret `alpha` (at most 512 bits) and posts
  `c = g^alpha mod N`. The beacon refuses `c` outside `0 < c < N`, the trivial
  values `1` and `N-1`, and any `c` already used under that round number.
- **Reveal.** The validator posts `alpha`. The device checks `g^alpha = c` and
  returns the output `y = h^alpha = c^(2^T)`, in canonical form.
- **Crack.** Anyone who has `c` can compute `y = c^(2^T)` by `T` sequential
  squarings (about 3 minutes on one core with GMP) and post it with a
  Wesolowski proof. The device checks the proof.

So every output is fixed when its commit is posted, but nobody except the
committer can know it before the reveal window, and nobody can withhold it
for good.

### 4.2 Round lifecycle

1. **Open.** The first commit to the round taking commits opens it and fixes
   its validator set: up to `maxActive` = 64 of the eligible validators
   (§4.5). Only a validator in that set may open it, and only when at least
   `minCommits` = 2 are eligible. In heartbeat mode the reserve pays
   `roundPrice` = 1 RNG for the round as it opens.
2. **Commit window.** Commits close as soon as the whole set has committed, or
   `commitWindowMs` = 5,000 ms after the first commit. Every member that did not
   commit is faulted (§4.6). With fewer than 2 commits the round is void: it
   reopens under the same number, keeping the hashes of every commitment it
   saw, and its sponsorship goes back to the reserve.
3. **Reveal window.** Validators reveal within `revealWindowMs` = 30,000 ms of
   commit close. The next round takes commits meanwhile.
4. **Finalize.** When every committed output is in (revealed or cracked) the
   value is `H("hyperbeam/rng/any-honest/v1/round|" self "|" r "|" y_1 "|" ... )`,
   outputs ordered by validator address. Each request's value is
   `H(".../request|" value "|" requester "|" requestId)`; each subscription's
   is `H("hyperbeam/rng/subscription/v1|" value "|" id "|" r)`. Processes get
   `RNG-Result` or `RNG-Subscription`; wallets read the round record
   `beaconround-<r % 8>`.
5. **Late.** A round past its reveal deadline with an output missing is late:
   each missing validator is faulted, and the round now publishes its commits
   in full for crackers. Late rounds do not hold up newer ones.
6. **Abandon.** A late round is abandoned `abandonAfterMs` = 30 min after its
   deadline only if a member of its set never committed, or the treasury cannot
   pay a crack bounty. Otherwise it waits for its crack, up to a hard cap of 7
   days, so a withholder who has seen the other outputs cannot void a value it
   dislikes. Abandoned requests are refunded in full at the price they paid,
   and requesting processes get `RNG-Error Round-Abandoned`. A round that never
   opens is handled the same way: its requests are refunded 30 min after the
   oldest one.

**Rhythm.** Round r is due at `rhythmAt + (r - rhythmRound) * targetIntervalMs`
(500 ms, so 2 rounds/s on average). Rounds open at least `cadenceMs` = 100 ms
apart, at most `maxInFlight` = 3 revealing at once, and lateness beyond
`catchUpMs` = 30 s is forgiven rather than repaid in a burst.

### 4.3 One message per round

A validator sends `Act { reveals: [{ round, alpha }...], commit: { round, c } }`:
its reveals for the rounds now revealing and its commit for the open round, at
most 16 parts. Each part runs exactly as its own `Reveal` or `Commit` would, and
one part's refusal does not stop the others. This halves the messages a round
costs.

### 4.4 Cracks and bounties

After a reveal deadline anyone may send `Crack { round, validator, y, proof }`.
A valid crack earns `crackBounty` = 10 RNG from the treasury, and the treasury
is repaid up to 10 RNG from the withholder's bond. The cracker also takes the
withheld seat's share of the round's pay. The bounty is never paid from the
reserve. A crack is refused while the treasury holds less than the bounty.

### 4.5 Validators

- **Join.** A token transfer to the beacon with `X-Bond` that brings the bond to
  at least `stake` = 25,000 RNG registers the sender (or `X-For`). A smaller
  first bond is refunded. The registry holds at most `maxValidators` = 256; when
  full, a new bond evicts and refunds the lowest-ranked entry that never sent
  Ready and registered at least 1 hour ago, or is refused `Registry-Full`.
  Anyone may `Evict-Idle` an entry that has not sent Ready 7 days after joining.
- **Ready.** A validator gets work only after `Ready`, and only with a full
  stake: a slashed bond is refilled from its unclaimed earnings first, then needs
  new tokens. Ready is refused while it owes an overdue output or during its
  cooldown.
- **Eligible.** Ready, not exiting, and not overdue on any late round.
- **Seats.** If more than `maxActive` are eligible, a quarter of the seats
  (`maxActive // 4` = 16) go to those ready the longest without a break, and the
  rest by rank: `min(bond, 4 x stake)` descending, then join time, then address.
  A newcomer cannot outrank an incumbent bonded at the 100,000 RNG cap, and no
  bond buys the seniority seats.
- **Leave.** `Pause` takes no new rounds, no slash; rounds already held are still
  owed. `Exit` then `Finalize-Exit` (once nothing is owed) refunds the bond.
  `Exit-Now` is the exit hatch (§7.4).
- **Claim.** Earnings accrue in atoms and go out on `Claim`.

### 4.6 Faults, slashing and cooldown

A missed commit (in a round's set, no commit in the window) or a missing output at
a reveal deadline is a fault. Each fault takes `slash` = 1,000 RNG of the bond to
the treasury, with no allowance. The first fault of an incident suspends the
validator, so only rounds it already held can fault it again. It also starts a
cooldown before Ready is accepted: `rejoinBaseMs` = 60 s, doubled per incident up
to `rejoinCapMs` = 1 hour; a validator that stays ready for the cap starts over.

The hard bounds cap one incident at half the stake:
`2 x (1 + maxInFlight) x (slash + crackBounty) <= stake`
(defaults: one incident costs at most 4 x 1,010 = 4,040 of 25,000).

### 4.7 Hard bounds

No vote can set a parameter outside these (`badParams`):

| Parameter | Bound | Live value |
|---|---|---|
| `T` | 2^27 to 2^32 | 2^27 |
| `commitWindowMs` | 500 to 10,000 | 5,000 |
| `revealWindowMs` | 10,000 to 600,000 | 30,000 |
| `abandonAfterMs` | `revealWindowMs` to 7 d | 1,800,000 |
| `stake` | at most 10,000,000 | 25,000 |
| `slash` | 1 to `stake / 10` | 1,000 |
| `crackBounty` | 1 to `slash` | 10 |
| `rejoinBaseMs`, `rejoinCapMs` | base >= reveal window, base <= cap <= 30 d | 60,000, 3,600,000 |
| `minCommits` | 2 to `maxActive` | 2 |
| `maxActive` | 8 to 128 | 64 |
| `maxValidators` | `maxActive` to 1,024 | 256 |
| `cadenceMs`, `targetIntervalMs` | 0 to 60,000; 0 to 600,000 | 100, 500 |
| `maxInFlight` | 1 to 8 | 3 |
| prices (`roundPrice`, `requestPrice`, `subscriptionPrice`) | 1 to 1,000,000 RNG | 1, 4, 1 |
| `subscriptionRounds` | 1 to 31,536,000 | 1,000 |
| `heartbeat` | 0 or 1 | 1 |

`token`, `unit`, `self` and `predecessor` are fixed at genesis. The bounds hold for
the code that runs; a code upgrade could change them, which is why code waits the
same 24 hours (§7).

### 4.8 Requests and subscriptions

A request is `Request-Random { Request-Id }` against a prepaid balance, or one
token transfer with `X-Request-Id` (pay and request). It binds to the round
taking commits, whose outputs nobody can know yet. A request id is remembered
10 minutes (scheduler time) so a resend is answered as a duplicate; copies of a
signed message are refused by the scheduler itself. A process may `Subscribe`
for up to 31,536,000 rounds at 1 RNG per 1,000, with at most 16 live
subscriptions; it receives an `RNG-Subscription` every covered round.

## 5. Fast tier

Fast is not a beacon: a round exists only when a paid request waits for it. A
request binds to the next unsigned round, or the one after if that round is
already locked. The three `rng-provider` daemons each post a `Partial` BLS
signature on `hyperbeam/rng/v1|<self>|<round>`; the first partial locks the round
to new requests. Each daemon reads the others' partials, combines two into the
group signature, verifies it off-chain and posts `Round`. In the live
`attestations` mode a round finalizes when 2 members post the same signature, so
one stolen key cannot inject a value. The value is
`H("hyperbeam/rng/v1/round|" message "|" signature)`.

The price is `threshold x signerFee + protocolFee` = 2 x 1 + 1 = 3 RNG. Each of
the round's signers earns its fee (`Claim`); the protocol's share accrues and
only the DAO can send it on (`Gov.Claim-Protocol`). The committee holds no bond.
An unsigned round is abandoned 30 minutes after its oldest request and refunded.
If its value was already computable from published partials, it waits 7 days
after the lock instead, and the locked number is skipped. A committee change
needs a new DKG ceremony and is a money action (§7).

## 6. Fair play

A game opens a session for a player key (`Fair.Open { Session, Player }`),
reserving one request price (4 RNG) from the game's prepaid balance, or is
refused `Game-Unfunded`. The allowance lasts 10 minutes. The player's browser,
with an ephemeral RSA-PSS key, commits
`H("rng/fair/v1/commit|" game "|" session "|" s)` for a 32-byte secret `s`. The
fair process batches commits and keeps one Any-Honest request outstanding; the
value `v_b` it binds was unknown to everyone when the commits were made. Each
session gets `v = H("rng/fair/v1/beacon|" v_b "|" game "|" session)` and must
reveal `s` within `fairWindowMs` = 60 s:

- reveal: `final = H("rng/fair/v1/final|" v "|" s)`;
- no reveal: anyone sends `Fair.Expire`, `final = H("rng/fair/v1/forfeit|" v)`.
  Games must score a forfeit as the worst outcome.

The game, the fair process and every validator together still cannot predict
`final`, because they never see `s` before `v_b` is fixed. The batch's 4 RNG is
split over its sessions (the first `price mod n` pay one atom more), and the fair
process tops its beacon balance back up after every bound batch. Games withdraw
their free balance at any time (`Fair.Withdraw { Nonce }`). A game can also embed
`lib/fair.lua` and skip the hop.

## 7. Governance

### 7.1 Owners

The launch wallet spawned the token, DAO, beacon, Fast tier and fair play, sent
the genesis configuration and the funding transfers, then sent `Gov.Set-Dao` and
`Gov.Renounce-Wallet` to the three governed processes. The RNG DAO is now their
only owner, believed only as a `from-process` attested by the shared scheduler.
`Gov.Renounce-Wallet` is refused while any action is pending, so nothing the
wallet started outlives it. The token has no owner at all.

### 7.2 The DAO

The RNG DAO is a YapDAO `stake-dao/1` instance staking RNG. Rules
(`daoRules`): voting period 1 day; quorum 10 % of staked RNG; a proposal passes
when Yes is above 50 % of Yes + No + NoWithVeto, and is vetoed when NoWithVeto is
above 33.34 % of all votes; threshold 25,000 RNG; deposit 5,000 RNG; unstake delay
14 days; at most 20 open proposals and 1 per proposer. A passed proposal sends one
tags-only message carrying `X-Dao-Proposal`; a redelivery of the same proposal
does nothing.

RNG Labs staked 50,000,000 RNG at launch, the majority of the stake, so Labs
decides votes until a coalition stakes more. Because quorum is 10 %, a proposal
can pass on low turnout if Labs does not vote: Labs runs `deploy.mjs watch` and
votes on every proposal.

### 7.3 Effective-At

| Class | Examples | When it applies |
|---|---|---|
| Harmless | prices and fees, `Abandon-After-Ms`, `Catch-Up-Ms`, cooldowns, `Heartbeat`, raising `Max-Active`/`Max-Validators`, lowering `Min-Commits`, `Gov.Pause`, `Gov.Resume` | on receipt, or at a later `Effective-At` it names |
| Money or code | `Stake`, `Slash`, windows, `Crack-Bounty`, `Max-In-Flight`, `Cadence-Ms`, `Target-Interval-Ms`, `Round-Price`, `T`/`H`, lowering `Max-Active`/`Max-Validators`, raising `Min-Commits`; `Gov.Treasury-Spend`, `Gov.Fund-Reserve`, `Gov.Remove-Validator`, `Gov.Set-Dao`, `Gov.Approve-Code`; Fast committee and `Gov.Claim-Protocol`; fair `Beacon`/`Token` | `Effective-At` at least 24 h after receipt |
| Reserve | `Gov.Set-Successor`, `Gov.Move-Reserve` | at least 7 days after receipt |

A money action is checked on a copy of the state when it arrives, stored in
`govPending`, and applied by anyone's `Gov.Apply Gov-Id` once due; the bounds are
checked again then. It lapses 14 days after it was due. `Effective-At` may be at
most 90 days ahead, and at most 32 actions wait at once. The DAO drops one with a
later `Gov.Cancel`. The floors are constants in `vendor/gov.lua`: no vote can
lower them, only new code, which itself waits 24 hours.

Code upgrades are in place: `Gov.Approve-Code { Code-Root, Effective-At }`, then
anyone uploads the matching bundle with `Gov.Upgrade` (one message, or a manifest
and parts). It installs only at or after `Effective-At`; state is kept.

### 7.4 Exit hatch

From the receipt of a money or code action until its `Effective-At` plus one hour
(unless applied, cancelled or refused first), `hatch` is true and:

- an Any-Honest validator may `Exit-Now`: it leaves every round not yet opened and
  gets its bond back at once, less 10 RNG held for each round it committed to but
  has not revealed. It is
  never slashed for those rounds and earns nothing from them; a crack of one is
  repaid from the hold. The rest of the hold comes back when those rounds settle.
- a Fast committee member may `Exit-Now` with its earnings.
- payers `Withdraw` and games `Fair.Withdraw` (these work at any time anyway).

### 7.5 Treasury cap

Treasury spends and reserve funding together are at most 10 % of the treasury in
any rolling 30 days: the outflows of the window plus the new one may not exceed a
tenth of (treasury now + those outflows). At most 64 outflows are remembered. A
spend never goes to the DAO, the beacon or the token. Governance can never take a
bond: `Gov.Remove-Validator` refunds it in full and is refused while the validator
has a commit in flight.

## 8. Token

RNG has 6 decimals and a fixed supply of 1,000,000,000 (10^15 atoms, below 2^53,
so every balance is exact). The whole supply was minted once, on the first slot,
to one allocation (RNG Labs, `DA9qhP25…`); the token refuses everything if the
allocations do not sum to exactly 10^15, then seals. There is no faucet, no mint
and no admin power over balances; the only admin action left is
`Admin.Checkpoint`. Transfers from processes follow `sequenced-v1`: each carries
an increasing `X-Transfer-Sequence`, deduplicated in a 256-wide window, and every
`Credit-Notice` carries a reference `t<n>` that the receiving process counts
once.

## 9. Pricing

| Item | Price | Goes to |
|---|---|---|
| Any-Honest request | 4 RNG | 1 to the treasury, 3 split evenly among the round's contributors (remainder atoms to the treasury) |
| Heartbeat round | 1 RNG from the reserve | split among the round's contributors |
| Subscription | 1 RNG per 1,000 rounds | treasury |
| Fast request | 3 RNG | 1 to each of 2 signers, 1 to the protocol |
| Fair batch | 4 RNG (one Any-Honest request) | split over the batch's sessions |

A contributor is the validator whose output a round used, or the cracker that
supplied it; a seat left by the exit hatch is paid to nobody.

**Pay at deposit.** A prepaid balance is a purse of up to 8 batches, each at the
prices in force when it was credited (a deposit at a ninth price is refunded).
A request pays the price of the oldest batch that covers it, and the payouts come
from that price, so a price rise binds only later deposits. Pay-and-request pays
today's price. `Withdraw` returns unused balance at face, newest batch first. An
abandoned request is refunded at the price it paid. This is why price changes are
harmless governance.

## 10. Economics

| Item | Value |
|---|---|
| Supply | 1,000,000,000 RNG, fixed |
| Genesis | all to RNG Labs |
| Reserve (heartbeat), in the beacon | 200,000,000 |
| Treasury, in the beacon | 50,000,000 |
| Labs DAO stake | 50,000,000 |
| Launch validators | 3, each bonded 100,000 (4 x stake) |
| Rest | with Labs: market seeding (Paralith RNG/PUSD) and later sale |

The reserve and treasury stay inside the beacon because a `stake-dao/1` DAO can
never send an action to the token it stakes; RNG sent to the DAO process would be
stuck. The DAO controls both through `Gov.*`.

**Reserve runway.** At 2 rounds/s and 1 RNG a round the reserve pays 172,800 RNG a
day, so 200 M lasts about 1,157 days (3.2 years). The treasury can extend it with
`Gov.Fund-Reserve`, within the cap. With the reserve empty the beacon keeps
running in request-driven mode: rounds open only for paid requests.

**Validator pay.** Heartbeat pay per validator is `2 / n` RNG a second plus a
share of requests (3 RNG / n each). With n = 3 that is 57,600 RNG a day each, so
the 25,000 stake is about 10 hours of pay and a slash about 25 minutes; with
n = 64 a validator earns 2,700 a day and a slash is about 9 hours. Entry pays until
the active set fills, so the set grows toward `maxActive`. A fault always costs
more than the rounds it skipped. After the reserve, validators live on requests.

**Treasury income.** 1 RNG per request, subscriptions, slashes (1,000 each) and
rounding dust. Net of a crack, the treasury gains 1,000 per withheld reveal
(slash 1,000, bounty 10 repaid from the bond).

## 11. Security

| Threat | Mitigation | What remains |
|---|---|---|
| Forged sender or DAO message | identity only from signature commitments; mixed signers are nobody; a `from-process` is believed only when our scheduler signed it; every message must commit to this process as target | trust in the scheduler's operator |
| Replay | the scheduler assigns a signed message once; request ids remembered 10 min; token references once; DAO proposals once | none known |
| Bias by withholding | outputs fixed at commit close; withholding is slashed and cracked; complete rounds are not abandoned while a bounty is payable | delay, up to 7 days, at a slash per round |
| Sybils buy the round | rank by capped bond; 16 of 64 seats by seniority; operators at the cap | an attacker at the cap can take up to three quarters of the seats from incumbents below it |
| Registry spam | bond >= stake to join; cap 256; idle entries evicted | a squatter that sends Ready must then work |
| DAO capture | 1-day vote, one-third veto, 24 h floor (7 d for the reserve), exit hatch, treasury cap 10 %/30 d, bonds and balances out of reach | the reserve via a successor and 10 % of the treasury, visibly and after the floor |
| Empty reserve | request-driven mode; stuck requests refunded | heartbeat consumers see gaps |
| All validators down | `health = halted`, console banner; requests refunded after 30 min | liveness depends on operators |
| Fast collusion | 2 of 3 can predict or choose a Fast value; requests bind before the first partial | use Any-Honest or fair play when that matters |
| Fair: player grinds or withholds | commit fixed before the request; forfeit is final and scored worst | a game that rewards forfeit is broken |
| Fair: game and validators collude | they never see `s` | none for an honest player |

## 12. Known limits

- **One scheduler.** Token, DAO, beacon, Fast and fair share one scheduler, and
  every cross-process trust rests on its `from-process` attestation. Its operator
  can delay or censor messages; it cannot forge a signature or a value.
- **Small launch set.** Mainnet launched with 3 Any-Honest validators bonded by RNG
  Labs and a 3-member Fast committee. Any-Honest safety is only as wide as the set
  in each round until outside validators bond.
- **Labs controls the vote** at launch, and quorum is low; Labs must vote on every
  proposal. There is no instant fix: the fastest brake is a 1-day vote
  (`Gov.Pause`), the fastest money or code change one vote plus 24 hours.
- **Node storage.** HyperBEAM keeps every slot. The processes keep bounded state
  (8 recent Any-Honest rounds, 32 Fast rounds, 1,024-entry history indexes) and
  everything older is read per slot. A rebuilt VM runs the spawn module, so an
  installed upgrade must be resent after a cold restore.
- **Fast verification** runs in `attestations` mode (2 identical signatures, each
  checked off-chain by its poster), not on-chain BLS verification.
- **Pricing quirks, deferred to v4.** Credits keep their purchase price forever, so
  after a price rise old cheap credits underpay validators; the Fast committee may
  then want to refuse cheap rounds (today an unsigned round is refunded after 30
  minutes); the heartbeat subsidy's economics once fees are set by a market.

## 13. v4 (not built)

- **Validator fee marketplace.** Each validator sets its own fee; a beacon is a
  chosen validator set and costs the sum of its members' fees plus the protocol
  fee; a fee change takes effect only after notice; deposits lock prices per set.
  It ships as an in-place upgrade through `Gov.Approve-Code`.
- **Whisper network.** Validators gossip commits and reveals peer to peer and post
  bundles, cutting messages per round as the set grows. The Go libp2p GossipSub
  prototype with an on-chain peer registry is kept in
  [`../history/whisper-node/`](../history/whisper-node/).

## 14. What changed since the v2 paper

[`docs/paper`](../paper/) (v2) described tiers `quick` and `timelock`, a fixed
validator set run without staking, a price of one RNG per serving validator plus
one, and owner-wallet administration. v3 changes:

- tiers renamed Fast (now on demand, no heartbeat) and Any-Honest;
- permissionless validators with bonds, slashing, cooldowns, a 256-entry registry
  and a 64-seat active set with seniority seats;
- fixed prices (4 and 3 RNG) and pay at deposit;
- DAO-only governance with Effective-At, the exit hatch and the treasury cap;
  in-place code upgrades;
- a fixed-supply token with no faucet or mint;
- reserve-funded heartbeat with request-driven fallback; refunds for stuck and
  abandoned rounds;
- fair play;
- batched `Act`, crack bounties from the treasury, the 7-day abandon cap.

## Appendix A: sources

Line numbers are at commit time of this paper.

| Claim | Source |
|---|---|
| Process ids, scheduler, owners, DAO rules, genesis split | `deploy/v3-mainnet.json` |
| Live beacon parameters | `deploy/v3-params.json` (genesis `Gov.Configure`; read `beaconinfo.params` for changes since) |
| N, g, T floor, abandon cap, idle eviction, treasury window | `protocol/beacon/anyhonest.lua:33-73` |
| Seats, ranking, eligibility | `anyhonest.lua:546-595` (`eligibleValidators`, `rankSort`, `activeValidators`) |
| Faults, slashing, cooldown | `anyhonest.lua:634` (`fault`) |
| Commit close, void, rhythm | `anyhonest.lua:679-745` |
| Abandon rules | `anyhonest.lua:748-845` (`refundPending`, `abandonable`, `advance`) |
| Round value, payouts, subscriptions | `anyhonest.lua:847` (`finalize`) |
| Bonds, pay-and-request, credits | `anyhonest.lua:1003` (`Credit-Notice`) |
| Requests, subscriptions | `anyhonest.lua:1108`, `:1140` |
| Commit, Reveal, Crack, Act | `anyhonest.lua:1180`, `:1237`, `:1252`, `:1300` |
| Exit, Exit-Now, Ready, Pause, Evict-Idle | `anyhonest.lua:1330-1471` |
| Hard bounds | `anyhonest.lua:1534` (`badParams`) |
| Treasury cap | `anyhonest.lua:1562-1582` |
| Money classes, Effective-At, Gov.Apply | `anyhonest.lua:1764-1902` |
| Floors, hatch, pending limits, code upgrade | `protocol/vendor/gov.lua:1-135`, `:147-155`, `:270-365` |
| Fast price, rounds, abandon, exit | `protocol/beacon/beacon.lua:73-99`, `:346`, `:647-790`, `:807` |
| Fast governance classes | `beacon.lua:986-1087` |
| Fair hashes, bounds, flow | `lib/fair.lua:1-90`, `:189-490` |
| Fair process messages | `protocol/fair/fair.lua:1-50`; live config `deploy/deploy.mjs:883` (`configure-fair`) |
| Purses | `lib/rng.lua:330-395` |
| Token supply, sequenced-v1 | `protocol/token/rng-token.lua:1-30`, `:224-250`, `:449-500` |
| Labs stake, Effective-At filling | `deploy/deploy.mjs:188`, `:276` |
| Fast committee size and threshold | `deploy/committee.json` |
| Launch validators | `deploy/anyhonest-validators.json`, `v3-mainnet.json` `genesis.validatorRng` |
| Crack time | `docs/ANY_HONEST.md` (measured, not code) |
| Reserve runway, pay figures | arithmetic on the values above |

## Appendix B: where other docs disagree with the code

- `docs/ANY_HONEST.md` opens with "v3 ... not yet deployed" and names the v2 beacon
  `MZMoXv-2` as live. v3 is live (`deploy/v3-mainnet.json`).
- `protocol/device/README.md` calls the device `timelock@1.0`; the processes call
  `/~rng@1.0/...` (`anyhonest.lua` `device()`, `beacon.lua` `verifySignature`).
- `docs/PERMISSIONLESS.md` design-record rows (D2, D11, D17, the handler table, the
  10-day timelock, `Gov.Handover`, 7-day votes) are superseded, as that file says;
  its "Governance at launch" section matches the code.
- `docs/paper` (v2) prices, tiers and "no staking" no longer apply (§14).

No disagreement was found between "Governance at launch", the hard bounds, the
state bounds or the economics table of `PERMISSIONLESS.md` and the code.
