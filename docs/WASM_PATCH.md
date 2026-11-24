# RNG on wasm-patch@1.0

2026-11-24. The token, the Any-Honest beacon, the fast tier and fair play run
on `wasm-patch@1.0` (PUC Lua 5.3 compiled to WebAssembly, AOT-compiled by the
node) instead of `lua-patch@1.0` (Luerl). The RNG DAO stays on lua-patch
(paralith-mono's stake-dao/1; its messages are rare).

## What ships

| Repo | Branch | What |
|---|---|---|
| hyperbeam-v011 | `feat/wasm-patch-rng` (off `integ/wasm-fast` 204a7862d) | `hb_wasm_nif`: `wp_rng_bls`, `wp_rng_reveal`, `wp_rng_crack`, `rng@1.0`'s three checks in C (blst, libcrypto BN), fixed fuel; `dev_rng`'s prime table as a literal; prewarm of wasm-lua `5c6497d71b82`; `dev_rng` `rng_matches_lua_patch` |
| paralith-mono | `feat/wasm-lua-rng` (off `release/wasm-fast` 09a77ee1) | wasm-lua `5c6497d71b82`: `src/rng_device.lua` serves `ao.resolve({ path = "/~rng@1.0/<key>" })` over those natives |
| rng | `perf/rng-wasm-patch` (off `rng/release-wasm-fast` 6db3130) | deploy on wasm-patch (`$RNG_DEVICE`, `deploy/wasm-runtime.json`), the fast tier's flat-cost request window, the order check, the e2e harnesses |

Merge order: a node image with `feat/wasm-patch-rng` first. A process on
runtime `5c6497d71b82` is refused at init by a node without the `wp_rng_*`
natives, and paralith-mono's `published.json` names that runtime on its branch.

## Results

Local node, this machine (Windows, Docker Desktop, 24 cores), production
snapshot cadence. Before = today's `rng/release-wasm-fast` on lua-patch,
`hb-integ:204a7862d`. After = this branch on wasm-patch, `hb-rng:547c0f57d`.
Same harness and load both sides (`deploy/fast-e2e.mjs --every-ms 100
--sample-ms 100`; `deploy/anyhonest-e2e.mjs --every-ms 250 --sample-ms 100
--fair 10`; `deploy/saturate.mjs --concurrency 32`).

**Round trip** (send -> value readable)

| | before p50 / p95 | after p50 / p95 |
|---|---:|---:|
| Fast request, 10 req/s | 2,240 / 26,388 ms | **1,293 / 1,828 ms** |
| Any-Honest request, 4 req/s | 1,751 / 2,529 ms | **1,121 / 1,527 ms** |
| Any-Honest round (open -> final) | 823 / 1,113 ms | 606 / 722 ms |
| Fair draw (open -> resolved) | 5,236 / 6,635 ms | 5,571 / 6,037 ms |

**Throughput**

| | before | after |
|---|---:|---:|
| Fast rounds/s at 10 req/s | 0.48 (falls behind) | 1.09 |
| Any-Honest rounds/s | 1.49 | 2.02 (the 500 ms rhythm) |
| Token, confirmed msg/s, saturated | 28.7 | 33.3 |

**Node time per slot** (`/~hyperbuddy@1.0/slots`; exec = the device call,
mostly the contract; store = writing the slot)

| process / message | before exec | after exec | before store | after store |
|---|---:|---:|---:|---:|
| fast: Credit-Notice / Partial / Round | 88 / 55 / 102 ms | 7.6 / 6.9 / 9.4 ms | 8 ms | 24 ms |
| beacon: Act / Credit-Notice | 134 / 54 ms | 13.4 / 6.5 ms | 14 ms | 18 ms |
| fair: Open / Commit / Reveal / RNG-Result | 38 / 34 / 67 / 51 ms | 2.7 / 2.6 / 4.1 / 3.0 ms (flat fix; 5.0 / 3.9 / 5.8 / 6.1 before it) | 13 ms | 11 ms |
| token: Transfer | 5.2-9.5 ms | 2.0-3.0 ms | 13-18 ms | 28-31 ms |

**rng@1.0 per call** (direct, `hb-integ:204a7862d` vs the branch)

| key | before | after (Erlang, lua-patch) | wasm-patch |
|---|---:|---:|---|
| verify-bls | 1.63 ms | 1.52 ms | blst in the NIF, same code |
| verify-reveal | 1.68 ms | 0.71 ms | libcrypto in the NIF |
| verify-crack | 2.91 ms | 1.34 ms | libcrypto in the NIF |
| `hb_ao:resolve` around a call | +0.65 ms | +0.65 ms | none (a direct native call) |

Reading it:

- The contracts were the cost: 50-130 ms of Luerl per slot, now 4-13 ms.
  The fast tier also stops degrading with load (its p95 was 26 s).
- Any-Honest's round trip is set by its rhythm (500 ms target, commit
  window) more than by compute; fair's by its batching window.
- What is left per slot is the node: `store` (LMDB commit and scans, 6 ms
  commits under the higher slot rate on Docker Desktop) and the schedule
  path, not the guest. One process tops out near 33 confirmed msg/s here.
- BLS verification (~1.5 ms, blst) is the floor for a round; nothing to win
  in the device beyond the prime table.

## Correctness

- **rng@1.0 parity.** `dev_rng:rng_matches_lua_patch_test_` (hyperbeam, needs
  `HB_WASM_LUA`): 137 vectors (the device's interop vectors, malformed inputs,
  derive edge cases) give the same status and value through lua-patch@1.0
  (Erlang device) and wasm-patch@1.0 (C natives), interpreted and AOT; a slot
  that cannot pay a native's fuel traps under both. The same vectors replay
  on the runtime's JS host (paralith-mono `runtime.test.mjs`).
- **Iteration order.** Luerl walks `pairs` sorted, PUC in hash order.
  `node protocol/test/order-check.mjs` runs every contract suite with `pairs`
  forced ascending, then descending, and compares a digest of every compute
  result. Two leaks found and fixed, both now walking keys sorted (Luerl's
  order, so lua-patch output is unchanged): the token's genesis refusal named
  the first bad allocation in `pairs` order, and the Any-Honest beacon handed
  out `rng-subscription-<i>` (and each subscriber's results) in `pairs` order.
- **Suites.** `test:protocol`, `test:node`, deploy config tests and the
  fast/Any-Honest e2e runs pass on the branch.

## The fast tier's request window

Every message deep-copied (for rollback) and republished (`beaconstate`) the
whole state, including the 10-minute window of request ids, so a message cost
~10 µs and ~127 B per remembered request (wasm, `bench-wasm.mjs`):

| ids remembered | before | after |
|---:|---:|---:|
| 0 | 0.6 ms | 0.6 ms |
| 1,000 | 10 ms | 0.4 ms |
| 6,000 (10 req/s) | 59 ms, 766 KB published | 0.4 ms, 1.6 KB |
| 20,000 | 304 ms | 0.5 ms |

The window is now outside the rollback copy (one insert undone from a log)
and outside `beaconstate`, published in 256 shards `beaconseen-<n>` (FNV-1a of
`"<requester>|<id>"` mod 256; lib/js `fastSeenKey`). Readers of
`beaconstate.seen` moved to it.

## Fair play

The same pattern as the fast tier, wider: every state change deep-copied the
whole state for rollback and re-encoded every session, account and the
history (`fairstate`, `fairsessions`, `fairaccounts`, `fairhistory`).
`bench-wasm.mjs --role fair`, one funded `Fair.Open` (wasm):

| open sessions | before | after |
|---:|---:|---:|
| 0 (full history, credits) | 7.1 ms, 40 KB published | 0.5 ms, 0.8 KB |
| 1,000 | 92 ms, 628 KB | 0.4 ms, 0.8 KB |
| 10,000 (deploy's maxOpen) | 1,369 ms, 5.9 MB | 1.1-2.9 ms, 1.0 KB |

- Rollback: on wasm-patch through `ao.atomic` (the runtime's write journal,
  lua-atomic@1.0's contract), no copy; on lua-patch the deep copy as before.
  The suite runs both (`RNG_FAKE_ATOMIC=1 node protocol/test/run-fair-tests.mjs`).
- Sessions and accounts are published in 256 shards each,
  `fairsessions-<n>` / `fairaccounts-<n>` (n = FNV-1a of the game mod 256;
  lib/js `fairShard`, `fairShardKey`; `FairClient` reads them); a message
  rewrites only the shards of the games it touched. A shard holds every game
  that hashes to it, so its size is open sessions / 256: flat up to the
  configured `maxOpen`, slowly growing past it (50,000 open: ~9 ms).
- `fairstate` is a recovery checkpoint every 1000 changes (and on any owner
  or queue change), anyhonest.lua's rule; a restore from an older checkpoint
  counts on from `fairrev`. `fairhistory` is rewritten only when it moves.
- Pruned session keys (`done`) expire from a time-ordered queue instead of a
  scan of the whole map on every resolution.
- Measured end to end (`anyhonest-e2e --fair 10`, wasm): fair slot exec
  3.9 -> 1.9 ms (Open 2.7, Commit 2.6, Reveal 4.1, RNG-Result 3.0 ms); the
  draw round trip is fair's batching window (~5.6 s) either way.

## Left as is

- **The fast tier's `balances`/`purses`/`accrued` and `credited`** stay in
  `beaconstate`: bounded (CREDIT_KEEP 1000) or growing with accounts, not
  with requests. Fair's and the beacon's credit windows (1024) are scanned
  per credit: bounded.
