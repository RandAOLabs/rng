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
| `timelock` | commit-reveal of time-lock puzzles from every validator | only *all* validators together (any-honest) | ~2-4 s; worst case one crack | `n + 1` RNG |

Price rule everywhere: 1 RNG to each validator whose contribution served the
request, plus 1 RNG to the protocol. `quick` is the existing beacon process;
`timelock` is a separate beacon process specified below. Both deliver
`RNG-Result` in the same shape, so the library treats them alike.

## 2. Time-lock beacon (`timelock` tier)

### 2.1 Parameters (set by the admin, published in `beaconinfo`)

| Name | Meaning | Default |
|---|---|---|
| `T` | sequential squarings per puzzle | 2^27 |
| `modulusBits` | puzzle modulus size | 2048 |
| `commitWindowMs` | time from a round's first commit until commits close | 3000 |
| `revealWindowMs` | time from commit close until reveals are due | 10000 |
| `minCommits` | committed validators needed for a round to count | 2 |
| `cadenceMs` | minimum time between rounds | 5000 |

Security condition: a puzzle must take longer to solve than the commit
window, even on an attacker's fastest hardware. With `T` = 2^27 and an
assumed 0.1 µs per 2048-bit squaring (a large margin over CPUs at ~1 µs),
solving takes ≥ 13 s against a 3 s window. Honest crackers using native code
need ~2-3 min; this is only paid when a validator withholds.

### 2.2 Validators

Validators are a set kept by the beacon: `Admin.Add-Validator`,
`Admin.Remove-Validator` (owner only), effective from the next round. There
is no staking. Each validator holds an Arweave wallet (signs its posts) and
generates its own puzzles; there is no shared key and no key ceremony.

Strikes: a missed commit or a withheld reveal (cracked by someone else) adds a
strike. A validator with `suspendAfter` strikes (default 3) within the last
100 rounds is suspended until the admin reinstates it. A suspended validator
neither commits nor earns.

### 2.3 Puzzle

A validator prepares RSA moduli ahead of time: `N = p · q`, `p` and `q`
random primes of `modulusBits/2` bits. A modulus is used once.

For round `r`, the puzzle input is fixed by the round, not chosen:

    seed = beaconId || "|" || r || "|" || validatorAddress
    x    = (int(expand(seed, modulusBits + 64)) mod N)^2 mod N

where `expand(s, n)` concatenates `SHA-256(s || "|" || k)` for k = 0, 1, …
and keeps the first n bits (big-endian). Squaring keeps `x` among the
quadratic residues. The output is

    y = x^(2^T) mod N

The validator computes `y` instantly with its trapdoor
(`e = 2^T mod φ(N)`, `y = x^e mod N`). Anyone else needs `T` sequential
squarings.

### 2.4 Round

A round opens when requests are pending and `cadenceMs` has passed since the
previous round. Requests bind to the open round only until its first commit;
later requests bind to the next round.

1. **Commit.** Each active validator posts `Commit { round, modulus }` (hex
   `N`). The first commit sets `commitDeadline = t + commitWindowMs`. Commits
   after the deadline are refused. The commit set closes at the deadline or
   when every active validator has committed.
2. **Reveal.** Each committed validator posts `Reveal { round, y, p }`. The
   beacon checks it with `timelock@1.0/verify-reveal`: `1 < p < N`,
   `N mod p = 0`, then `y = x^(2^T mod (p-1)(q-1)) mod N` with `x` from the
   seed. Revealing `p` is safe: the modulus is never used again.
3. **Crack.** After `revealDeadline = commitClose + revealWindowMs`, any
   validator may post `Crack { round, validator, y, proof }` for a missing
   reveal: `y` computed by `T` squarings and a Wesolowski proof (2.5),
   checked with `timelock@1.0/verify-crack`. The cracker takes the missing
   validator's fee for that round; the withholder takes a strike.
4. **Finalize.** When every committed validator's `y` is known (revealed or
   cracked) and at least `minCommits` committed:

       value_r = SHA-256("rng/timelock|" || beaconId || "|" || r || "|" || y_1 || "|" || … || y_k)

   with the `y` values in lowercase hex, ordered by validator address. Each
   request gets `SHA-256(value_r || "|" || requestId)` (as the `quick`
   tier). Fewer than `minCommits` commits: the round is void and its
   requests move to the next round, unpaid and unrefunded.

Why it is any-honest: once commits close, every `y` is fixed but an honest
validator's `y` cannot be computed before the window ends, so nobody who
committed can know the outcome when deciding to commit. Withholding a reveal
changes nothing (the puzzle is cracked); it only delays the round.

### 2.5 Wesolowski proof (for cracks)

    l = nextPrime(int(SHA-256("rng/wesolowski|" || N || "|" || x || "|" || y || "|" || T))[0..128 bits] | 2^127 | 1)
    proof = x^floor(2^T / l) mod N
    valid iff proof^l · x^(2^T mod l) ≡ y (mod N)

`nextPrime` steps by 2 from the candidate and accepts the first number that
passes trial division by primes < 1000 and Miller-Rabin with the first 20
primes as bases. All hex is lowercase, integers are big-endian hex without
leading zeros.

### 2.6 What the beacon stores and publishes

Each finalized round keeps a record `{ round, opened, commitClose,
finalizedAt, commits: { addr: N }, outputs: { addr: { y, via: reveal | crack,
p | proof } }, value, requests }`, so anyone can re-verify it. The last
`ROUND_HISTORY` records are in `beaconstate`; indexers archive older ones.
Reads: `beaconinfo` (parameters, open round, phase, deadlines, validators,
strikes), `beaconstate`, `beaconround-open` (the current round's commits and
reveals, for validators).

### 2.7 Messages (time-lock beacon)

| Action | From | Data |
|---|---|---|
| `Request-Random` | anyone funded | tags `Tier = timelock`, `Request-Id` |
| `Commit` | validator | `{ round, modulus }` |
| `Reveal` | validator | `{ round, y, p }` |
| `Crack` | validator | `{ round, validator, y, proof }` |
| `Claim` | validator | — |
| `Admin.Add-Validator` / `Admin.Remove-Validator` / `Admin.Reinstate` | owner | `{ address }` |
| `Configure` | owner | parameters from 2.1, token, unit |
| `Withdraw`, `Balance`, `Get-Info` | anyone | as the `quick` beacon |

## 3. Device `timelock@1.0`

Stateless, deterministic, on the node; called from Lua with `ao.resolve`.

| Key | Inputs | Returns |
|---|---|---|
| `verify-reveal` | `modulus`, `seed`, `t`, `y`, `p` | `valid`, `x` |
| `verify-crack` | `modulus`, `seed`, `t`, `y`, `proof` | `valid`, `x` |
| `derive-x` | `modulus`, `seed` | `x` |
| `verify-bls` | as `vrf@1.0` (kept for the `quick` tier) | `valid`, `value` |
| `derive` | as `vrf@1.0` | `value` |

Bad input returns `valid = false` with a `reason`; it never raises. The
device was `vrf@1.0`; it is renamed because time-lock checks are now its main
job.

## 4. Validator node (daemon)

Keeps a pool of fresh moduli (prime generation ~20 ms each), watches the
open round, commits as soon as a round opens, reveals as soon as commits
close, and cracks any reveal still missing after the reveal deadline (native
squaring when available, else JavaScript). Never reuses a modulus. Signs
with its own wallet; no shared secret with other validators.

## 5. Out of scope for this version

Staking and slashing (strikes and suspension instead), drand or any outside
randomness, time-lock encryption for user data (planned on the same puzzles).
