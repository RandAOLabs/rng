# RNG protocol specification (v2)

RNG is RandAO rebuilt on HyperBEAM: the original any-honest time-lock
commit-reveal protocol, made fast and cheap by checking puzzles on the node
(`timelock@1.0`), and bundled with lighter tiers in one library.

Status: draft for implementation, 2026-10-26.

## 1. Tiers

One library call (`rng.request(msg, { tier = ..., on = ... })`); a call site
moves between tiers by changing `tier`.

| Tier | Source | Who can bias or predict it | Latency | Price |
|---|---|---|---|---|
| `local` | SHA-256 stream over the message (in-process) | the sender, by re-signing | same message | free |
| `quick` | threshold-BLS round from the committee (`t` of `n`) | `t` colluding validators can predict future rounds | ~1 s | `t + 1` RNG |
| `timelock` | commit-reveal of time-lock puzzles from every validator | only *all* validators together (any-honest) | ~1-2 s; worst case one crack (~7 min) | `n + 1` RNG |

Price rule everywhere: 1 RNG to each validator whose contribution served the
request, plus 1 RNG to the protocol. `quick` is the existing beacon process;
`timelock` is a separate beacon process specified below. Both deliver
`RNG-Result` in the same shape, so the library treats them alike.
`RNG-Result` and `RNG-Error` go only to requesters that are processes; a
wallet reads its result from the published round (a message to a wallet makes
the node look the address up on Arweave during every push).

### 1.1 `quick` beacon

Binding: with round `r` finalized, `Request-Random` binds to `r + 2`, while
`Partial` and `Round` are accepted only for `r + 1`. No partial or signature
for a round can exist, or be published, while requests can still bind to it.

Per request: `SHA-256(value_r || "|" || requester || "|" || requestId)`, as
lowercase hex, where `value_r = SHA-256("round|" || signature)` (hex) and
`requester` is the requesting address (the process id for a process).

Duplicates: a `Request-Id` already bound for this requester is answered with
`{ duplicate = true }`, never an `RNG-Error`, and is not charged again. A
request may carry `Request-Time` (the requester's message time in ms; the
library sets it); one older than 10 minutes or more than 2 minutes ahead is
refused as `Stale-Request`, so ids are forgotten after 10 minutes without a
late copy being charged twice. A request without `Request-Time` is protected
for those 10 minutes only. A `Credit-Notice` is accepted once per token
`Reference` (`t<n>`), permanently; dust or one without a valid account is
refunded to its sender.

Trust: identity is the node's word. The beacon trusts its node and scheduler
to have verified every signature commitment, and takes `from-process` as the
sender only on a message signed by its own scheduler. A dishonest node or
scheduler can impersonate senders, or delay and reorder messages; it cannot
forge a group signature.

## 2. Time-lock beacon (`timelock` tier)

### 2.1 Parameters (set by the admin, published in `beaconinfo`)

| Name | Meaning | Default |
|---|---|---|
| `T` | sequential squarings per puzzle (floor 2^20) | 2^27 |
| `h` | `g^(2^T) mod N` (2.3), set together with `T` and checked by the beacon | — |
| `commitWindowMs` | time from a round's first commit until commits close (500-10000) | 3000 |
| `revealWindowMs` | time from commit close until reveals are due | 10000 |
| `abandonAfterMs` | time after the reveal deadline before an unfinished round is abandoned | 1800000 |
| `minCommits` | committed validators needed for a round to count (at least 2) | 2 |
| `cadenceMs` | minimum time between the first commits of consecutive rounds | 1000 |
| `heartbeat` | 1: rounds run whether or not requests are waiting; 0: only when they are | 1 |
| `suspendAfter` | strikes within 3,600 rounds that suspend (and slash) a validator; also missed commits in a row that make it idle | 3 |
| `slash` | RNG taken from the bond on each suspension | 1000 |
| `rejoinAfter` | rounds after a slashed suspension before `Rejoin` is accepted | 600 |

`Configure` sets `token` and `unit` only while they are unset. A new `T`
must come with its `h` and `hProof` (a Wesolowski proof, 2.5, with `x = g`),
which the beacon checks with `timelock@1.0/verify-crack` before accepting
them. Each round keeps the `T` and `h` it opened with.

Security condition: a puzzle must take longer to solve than the commit
window, even on an attacker's fastest hardware. With `T` = 2^27 and an
assumed 0.1 µs per 2048-bit squaring (a large margin over CPUs at ~1 µs),
solving takes ≥ 13 s against a 3 s window. Honest crackers using native code
need ~2-3 min; this is only paid when a validator withholds.

### 2.2 Validators

Validators are a set kept by the beacon: `Admin.Add-Validator`,
`Admin.Remove-Validator` (owner only), effective from the next round. Each
validator holds an Arweave wallet (signs its posts) and picks a fresh secret
for every commit; there is no shared key and no key ceremony.
`Admin.Remove-Validator` is refused while the validator has a commit in a
round that has not finished.

Bond: each validator has a bond of RNG held by the beacon, funded by a token
transfer to the beacon tagged `X-Bond` and `X-For = <validator>` (25,000 RNG
on the test network). A validator is active only while its bond covers one
`slash` (default 1,000 RNG); one added without that starts suspended.
Removing a validator returns what is left of its bond.

Strikes: a reveal still missing at its round's reveal deadline adds a strike,
at most one per validator per `revealWindowMs` (one outage is one strike, not
one per round in flight). From that deadline until every one of its missing
outputs is filled (revealed late or cracked) the validator is overdue: it is
left out of new rounds. A validator with `suspendAfter` strikes (default 3)
within the last 3,600 rounds is suspended, and `slash` RNG moves from its
bond to the protocol; this applies to an idle validator too. A suspended
validator neither commits nor earns. `rejoinAfter` rounds (default 600) after
its suspension it may send `Rejoin`, which reactivates it and clears its
strikes as long as its bond still covers another slash; a 25,000 RNG bond
allows 25 suspensions. The admin can also `Admin.Reinstate`.

Idle: a missed commit only loses that round's fee. `suspendAfter` missed
commits in a row make the validator idle (suspended without a slash), so
rounds stop waiting out its commit window; it sends `Rejoin` when it is back
and is active again at once.

### 2.3 Puzzle

All puzzles live in one group whose order nobody knows: integers modulo the
RSA-2048 challenge number

    N = c7970ceedcc3b0754490201a7aa613cd73911081c790f5f1a8726f463550bb5b
        7ff0db8e1ea1189ec72f93d1650011bd721aeeacc2acde32a04107f0648c2813
        a31f5b0b7765ff8b44b4b6ffc93384b646eb09c7cf5e8592d40ea33c80039f35
        b4f14a04b51f7bfd781be4d1673164ba8eb991c2c4d730bbbe35f592bdef524a
        f7e8daefd26c66fc02c479af89d64d373f442709439de66ceb955f3ea37d5159
        f6135809f85334b5cb1813addc80cd05609f10ac6a95ad65872c909525bdad32
        bc729592642920f24c61dc5b3c3b7923e56b16a4d9d373d8721f24a3fc0f1b31
        31f55615172866bccc30f95054c824e733a5eb6817f7bc16399d48c6361cc7e5

whose factors were never published (RSA Laboratories, 1991). Because nobody,
validators included, knows the group order, nobody can shortcut `T`
squarings or forge a proof (2.5).

    g = (int(expand("rng/timelock/g", 2112)) mod N)^2 mod N
    h = g^(2^T) mod N

where `expand(s, n)` concatenates `SHA-256(s || "|" || k)` for k = 0, 1, …
and keeps the first n bits (big-endian). `h` is computed once per `T` (by `T`
squarings) and set with `Configure`.

For each commit a validator picks a fresh secret `alpha`, 256 uniformly
random bits, and commits

    c = g^alpha mod N

Its puzzle output is

    y = c^(2^T) = h^alpha mod N

The validator computes `y` instantly from `alpha`; anyone else needs `T`
sequential squarings of `c`. A secret is never used twice, also not after a
void. Outputs are compared and hashed in canonical form `y* = min(y, N − y)`,
so `y` and `N − y` (which pass the same checks) count as one output.

### 2.4 Round

Rounds overlap. The open round takes commits; as soon as its commits close
it moves to reveals and the next round opens, so several rounds can be
revealing at once and they can finish out of order (a cracked round finishes
minutes after the ones behind it). A round's first commit is accepted once
`cadenceMs` has passed since the previous round's first commit and, with
`heartbeat` off, only while requests are waiting for it. With `heartbeat` on
(the default) rounds run continuously, so a request waits for at most one
cadence plus one round (~1-2 s) unless that round needs a crack. A request
is accepted only while at least `minCommits` validators are active. Requests
bind to the open round (the one taking commits). Nothing is revealed before a
round's commits close, so its value is unknown to everyone, validators
included, until after the last request it can take. A value already
published is never used for a later request.

1. **Commit.** Each active validator posts `Commit { round, c }` (`c` as
   lowercase hex, `0 < c < N`). The first commit sets
   `commitDeadline = t + commitWindowMs`. Commits after the deadline are
   refused, and so is a `c` already committed in an earlier (void) attempt
   at the same round. The commit set closes at the deadline or when every
   active validator has committed.
2. **Reveal.** Each committed validator posts `Reveal { round, alpha }` once
   the beacon shows the round in its reveal phase (validators read this from
   `beaconinfo`, and send `Close { round }` to move a round whose window has
   passed but which has not seen a message since). The beacon checks it with
   `timelock@1.0/verify-reveal` (`g^alpha = c`) and records the returned
   `y*`. A reveal after the deadline is still accepted.
3. **Crack.** After `revealDeadline = commitClose + revealWindowMs`, anyone
   may post `Crack { round, validator, y, proof }` for a missing reveal: `y`
   computed by `T` squarings of `c` and a Wesolowski proof (2.5), checked
   with `timelock@1.0/verify-crack`. The cracker takes the missing
   validator's fee for that round.
4. **Finalize.** When every committed validator's `y*` is known (revealed or
   cracked):

       value_r = SHA-256("rng/timelock|" || beaconId || "|" || r || "|" || y*_1 || "|" || … || y*_k)

   with the `y*` values in lowercase hex, ordered by validator address. Each
   request gets `SHA-256(value_r || "|" || requester || "|" || requestId)`
   (as the `quick` tier).

   Fees: a request is charged `price` (active validators + 1) when it is
   made. At finalize it pays 1 RNG to the protocol and 1 to each of the first
   `k = min(contributors, charged − 1)` contributors by address (the cracker
   in place of a withholder); the rest goes back to the requester.

Fewer than `minCommits` commits: the round is void, its requests stay bound
to the same round number, and validators commit again with fresh secrets.
A round still unfinished `abandonAfterMs` after its reveal deadline is
abandoned: its requests are refunded in full (processes get `RNG-Error`
`Round-Abandoned`) and it never gets a value.

Why it is any-honest: once commits close, every `y` is fixed (each `c`
determines its `y`) but an honest validator's `y` cannot be computed before
the window ends, so nobody who committed can know the outcome when deciding
to commit. A withheld reveal changes nothing: anyone can crack it, a crack
can only produce the one `y` the commit fixed, and the round waits for it.

Trust assumptions: the scheduler orders and timestamps messages, and the
node vouches for signatures and `from-process`. A scheduler that delays an
honest validator's commit past the window can leave it out of a round; the
value is then only as good as the validators who did commit. Abandoning a
round needs every cracker to stay silent for `abandonAfterMs`.

### 2.5 Wesolowski proof (for cracks)

    l = nextPrime(int(SHA-256("rng/wesolowski|" || x || "|" || y || "|" || T))[0..128 bits] | 2^127 | 1)
    proof = x^floor(2^T / l) mod N
    valid iff proof^l · x^(2^T mod l) ≡ y (mod N)

`nextPrime` steps by 2 from the candidate and accepts the first number that
passes trial division by primes < 1000 and Miller-Rabin with the first 20
primes as bases. All hex is lowercase, integers are big-endian hex without
leading zeros. The proof is sound because nobody knows the order of the
group mod `N`.

### 2.6 What the beacon stores and publishes

Each finalized round keeps a record `{ round, opened, commitClose,
finalizedAt, T, h, commits: { addr: c }, outputs: { addr: { y, via: reveal |
crack, alpha | proof } }, value, requests }`, so anyone can re-verify it. The
last `ROUND_HISTORY` records are in `beaconstate`; indexers archive older
ones. Reads: `beaconinfo` (parameters, the open round and the rounds still
revealing with their phases, deadlines, commits and reveals, validators,
strikes), `beaconstate` (which also holds the rounds in progress as `opens`).

### 2.7 Messages (time-lock beacon)

| Action | From | Data |
|---|---|---|
| `Request-Random` | anyone funded | tags `Tier = timelock`, `Request-Id` |
| `Commit` | validator | `{ round, c }` |
| `Reveal` | validator | `{ round, alpha }` |
| `Close` | anyone | `{ round }` (closes commits whose window has passed) |
| `Crack` | anyone | `{ round, validator, y, proof }` |
| `Rejoin` | suspended validator | — (see 2.2) |
| `Claim` | validator or cracker | — |
| `Admin.Add-Validator` / `Admin.Remove-Validator` / `Admin.Reinstate` | owner | `{ address }` |
| `Configure` | owner | parameters from 2.1 (`T` with `h`, `hProof`), token, unit |
| `Withdraw`, `Balance`, `Get-Info` | anyone | as the `quick` beacon |

Request ids, credits and replies follow the `quick` beacon's rules (§1).

## 3. Device `timelock@1.0`

Stateless, deterministic, on the node; called from Lua with `ao.resolve`. `N`
and `g` (2.3) are built in.

| Key | Inputs | Returns |
|---|---|---|
| `verify-reveal` | `c`, `alpha`, `h` | `valid`, `y` (canonical `y*`) |
| `verify-crack` | `x`, `t`, `y`, `proof` | `valid`, `y` (canonical `y*`) |
| `generator` | — | `g`, `n` |
| `verify-bls` | as `vrf@1.0` (kept for the `quick` tier) | `valid`, `value` |
| `derive` | as `vrf@1.0` | `value` |

`verify-reveal` checks `0 < c < N`, `0 < h < N`, `alpha` at most 512 bits,
and `g^alpha ≡ c (mod N)`, then returns `h^alpha mod N` in canonical form.
`verify-crack` checks `0 < x, y, proof < N`, `t ≤ 2^32`, and the proof (2.5).
Bad input returns `valid = false` with a `reason`; it never raises. The
device was `vrf@1.0`; it is renamed because time-lock checks are now its main
job.

## 4. Validator node (daemon)

Watches the open round and commits `c = g^alpha` with a fresh random `alpha`
as soon as a round opens (no prime generation, no precomputation). Reveals
`alpha` once the beacon shows the round revealing (sending `Close` when the
window has passed and the beacon has not moved yet), and cracks any reveal
still missing after the reveal deadline (native squaring when available,
else JavaScript). Never reuses a secret. Signs with its own wallet; no
shared secret with other validators.

## 5. Out of scope for this version

Open staking (bonds are set up by the admin), drand or any outside
randomness, time-lock encryption for user data (planned on the same puzzles).
