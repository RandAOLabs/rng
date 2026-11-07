# RandAO RNG

Verifiable randomness for AO processes on HyperBEAM, created and operated by
**RNG Labs**, a product of **CipherPlay Inc.** Live console:
[randao.net](https://randao.net).

HyperBEAM sandboxes `math.random` (and `os.time`) because a seeded or
clock-based draw forks state between nodes and replays. `rng.install(msg)`
brings it back as a deterministic stream, and `rng.request` upgrades the same
code to verifiable randomness when value is at stake. The node's `~rng@1.0`
device verifies BLS signatures, time-lock reveals and cracks, and byte
derivation.

## Tiers

| Tier | Process | Safe unless | Price |
|---|---|---|---|
| Local | `lib/rng.lua` | always predictable to the sender | free |
| Fast | `protocol/beacon/beacon.lua` (on-demand 2-of-3 threshold BLS) | 2 of 3 committee operators collude | 3 RNG |
| Any-Honest | `protocol/beacon/anyhonest.lua` (time-lock commit/reveal) | every validator colludes | 4 RNG |

Fair play (`lib/fair.lua`, `protocol/fair/fair.lua`) adds the player's own
committed secret on top of a beacon value. Product surfaces:
[docs/PRODUCT.md](docs/PRODUCT.md).

```lua
local rng = require("rng")
rng.on("Loot-Roll", function(stream, ctx) grantLoot(ctx.player, stream:int(1, 6)) end)
rng.request(msg, { on = "Loot-Roll", ctx = { player = msg.From } })            -- local
rng.request(msg, { tier = "beacon", on = "Loot-Roll", ctx = { player = msg.From } }) -- fast
```

## Repo map

| Path | What |
|---|---|
| `lib/` | consumer libraries: `rng.lua`, `fair.lua`; `lib/js/` is the JS client (`@randao/rng`: fair play, pay-and-request, history, derive) |
| `protocol/` | AO processes (beacons, token, fair), their Lua vendor deps and Lua suites; `protocol/device/` holds the device notes |
| `validator/` | fast-tier committee daemon, Any-Honest validator and cracker, Dockerfiles |
| `site/` | randao.net console (vinext on workerd), its deploy config and tests |
| `deploy/` | `deploy.mjs`, launch runbook, configs, snapshots, DAO proposal templates |
| `docs/` | [SPEC](docs/SPEC.md) (threshold BLS), [ANY_HONEST](docs/ANY_HONEST.md), [PERMISSIONLESS](docs/PERMISSIONLESS.md) (v3 design), paper, soak |

## Test

```bash
npm ci && (cd site && npm ci)
npm test          # protocol Lua suites, validator + deploy node tests, site tests
```

The Lua suites run in the AOS wasm module from paralith-mono
(`PARALITH_ROOT`, or `AOS_WASM` and `AO_LOADER`). Site checks:
`cd site && npx tsc --noEmit && npm run lint && npm run build`.

## Deploy

`node deploy/deploy.mjs plan --dry-run` prints every spawn and message; the
runbook is [deploy/README.md](deploy/README.md). Live commands need `HB_NODE`,
`HB_WALLET` and `SSH_KEY`; no endpoint or credential is in the source. Images
build from the repo root: `docker build -f validator/Dockerfile.anyhonest .`,
`docker build -f site/Dockerfile .`.

## Ownership and licensing

Copyright © 2026 **CipherPlay Inc.** and contributors. RNG Labs is a CipherPlay
Inc. product and the protocol steward.

- `lib/` and `validator/` are MIT licensed (see their LICENSE files), so anyone can
  build on the library or run a validator.
- Everything else is all rights reserved. See [LICENSE](LICENSE). Contact
  CipherPlay Inc. for licensing.
