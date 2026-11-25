# Any-Honest beacon to wasm-patch@1.0: the migration

2026-11-25. The live beacon `Q_rRJ-Ct…` runs on lua-patch@1.0 and does ~1.55
rounds/s: each validator Act is ~138 ms of Luerl, three in series per round.
On wasm-patch@1.0 the same bundle's Act is ~13 ms, so the 500 ms rhythm
(2 rounds/s) is the limit, not compute.

The execution device is fixed at spawn, so this is a successor beacon, not an
upgrade. Fair play is pinned to its beacon (`beacon` is fixed once set), so it
gets a successor too. It has never had a game, so nothing moves with it.

## Proof (protocol/test/vm-parity.mjs)

The same spawn bundle and the same requests on both VMs, every slot compared
(replies, outbox, published patches, and the whole beacon state every 100
slots and at the end):

| stream | slots | identical |
|---|---:|---:|
| everything anyhonest_test.lua sends (rng@1.0 mocked, same on both) | 1,765 | 1,765 |
| 600 rounds of batched Acts, real puzzles, a paid request every 5th round (rng@1.0 real: runtime natives vs HyperBEAM dev_rng) | 1,948 | 1,948 |

## On a node (deploy/anyhonest-e2e.mjs, local hb-rng:547c0f57d, same machine and load)

| | lua-patch@1.0 | wasm-patch@1.0 |
|---|---:|---:|
| beacon Act, node exec | 63.4 ms | **5.6 ms** |
| request round trip p50 / p95 | 1,049 / 1,332 ms | **896 / 1,165 ms** |
| rounds/s | 1.997 | 2.002 |

Both reach the 500 ms rhythm here: this machine runs Luerl about twice as
fast as the live node (138 ms an Act there), and the e2e validators post
without waiting. Live, a round is three Acts in series plus the validators'
reaction (~80-140 ms): 3 x 138 ms misses the rhythm, 3 x ~6-13 ms does not.

## Preconditions

- The RNG node runs a HyperBEAM build with the rng@1.0 natives
  (`feat/wasm-patch-rng` 547c0f57d; in `integ/paralith-next`). The pinned
  runtime (deploy/wasm-runtime.json, `0c60afa65180`) imports `env.wp_rng_*`:
  an older node refuses the process at init.
- No DAO vote: the deployer wallet still co-owns the beacon and fair
  (`gov.wallet: true`), and on the wallet path Gov.Set-Successor,
  Gov.Move-Reserve and Gov.Set-Dao apply at once.

## Steps

`deploy/migrate-beacon-wasm.sh <stage>` runs them, one stage per call, each
read back: `check`, `spawn`, `handover`, `reserve`, `fair`, `repoint`,
`verify`, then `old claim` and `old exit` (twice: Exit, then Finalize-Exit once
the exit floor has passed). Env: HB_WALLET (the deployer), PARALITH_MONO (a
checkout with the pinned runtime), SSH_KEY (the committee key).

1. `spawn-beacon --replace` (wasm-patch; retires the old id in state), then
   `genesis-configure` with v3-params.json plus `predecessor: <old beacon>`.
   The genesis Configure sends Successor-Ack to the old beacon.
2. `set-dao beacon` (the RNG DAO co-owns it, as before), `fund-treasury`.
3. `bond-for 100000 <the three validator addresses>`: a validator that
   follows a successor never tops up there by itself.
4. Old beacon (wallet path): `Gov.Set-Successor successor=<new>`, then
   `resend-ack` from the new one. The in-node validators see a named,
   acknowledged successor, finish what they owe the old beacon, and move.
5. Old beacon: `Gov.Move-Reserve successor=<new>`. The heartbeat now pays on the
   new beacon and stops on the old one.
6. Watch: rounds/s, round latency, each validator Ready on the new beacon.
7. Fair: `spawn-fair --replace` on wasm-patch, `configure-fair`, `set-dao fair`.
8. Old bonds back: each validator `exit --beacon <old>` (its own wallet, on
   its host), then Finalize-Exit once it owes nothing.
9. Point everything at the new ids: the cracker (it was still on a pre-wipe
   beacon, `gdeBeFy6…`) and randao.net's console env (`repoint`, no rebuild:
   the console reads its ids from the env). paralith-mono:
   deployment-state.json `rng.beacon` / `rng.fair` and nodes.json
   `rngValidator.beacon` (so the next node apply does not put the validators
   back on the old beacon), then graph-sync.
10. The old beacon stays as it is: request-driven with no reserve, no
    validators. It is retired in state, not deleted.
