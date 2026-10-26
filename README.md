# RNG: verifiable randomness for AO

HyperBEAM's RC7 Lua runtime sandboxes `math.random`, so every process needs a
new source of randomness. RNG gives it one API with four security tiers:
start free, and upgrade a call site by changing one option.

| Tier | How | Who could cheat | Messages | Price |
|---|---|---|---|---|
| 0 `local` | SHA-256 stream seeded from the message | the sender (re-signing) | 0 | free |
| 1 `fast` | one provider's BLS signature (planned) | that provider, by refusing | 2 | 2 RNG |
| 2 `beacon` | threshold BLS beacon, 2 of 3 nodes | 2+ colluding nodes | 2 + shared round post | 3 RNG |
| 3 `max` | beacon + VDF (planned) | practically no one | 2 + 2 shared | 4 RNG |

Price rule: 1 RNG to each validator that served the request, plus 1 RNG to
the protocol. The launch committee is 3 nodes run by the RandAO team; seats
open to outside operators as the network grows.

## Use it

```lua
local rng = require("rng")            -- lib/rng.lua

rng.on("Loot-Roll", function(r, ctx)  -- named, so it survives reloads
  grantLoot(ctx.player, r:int(1, 6))  -- also r:float(), r:pick(t), r:shuffle(t), r:bytes(n)
end)

-- Tier 0: runs now, inside this message.
rng.request(msg, { on = "Loot-Roll", ctx = { player = msg.From } })

-- Tier 2: same continuation, runs when the round lands.
rng.config({ beacon = "<beacon process id>" })
rng.request(msg, { tier = "beacon", on = "Loot-Roll", ctx = { player = msg.From } })
```

Native `compute()` processes set `rng.config({ outbox = base.results.outbox })`
per message and pass the proven sender to `rng.handle(msg, from)`. Code that
still calls `math.random` can run unchanged with `rng.install(msg)` (tier 0).

## How the beacon works

1. A process funds a balance by sending TEST-RNG to the beacon.
2. `Request-Random` debits the price and binds the request to the next round,
   which nobody has signed yet.
3. Each committee node signs that round with its key share and posts the
   partial to the beacon. Nodes read each other's partials from the beacon,
   so they never connect to each other directly.
4. Any 2 partials combine into the same 96-byte BLS signature. A round
   finalizes when 2 nodes post the same verified signature.
5. The beacon answers each requester process with one `RNG-Result` holding
   `SHA-256(SHA-256("round|" .. sig) .. "|" .. requestId)` per request.

Keys come from a distributed key generation: no machine ever holds the
group key. The `vrf@1.0` HyperBEAM device (in progress) will let the beacon
verify the signature itself, cutting a round to one post.

## Testnet

Live on `https://hb.randao.net`; process ids in `deploy/testnet.json`.

## Layout

| Path | What |
|---|---|
| `lib/rng.lua` | the client library |
| `beacon/beacon.lua` | beacon process (native `~lua@5.3a` contract) |
| `token/rng-token.lua` | TEST-RNG faucet token |
| `provider/` | threshold BLS, DKG and the committee node daemon |
| `deploy/` | spawn, configure, fund; node install over SSH + Docker |
| `test/` | library, beacon and BLS suites |
| `web/` | the site: live beacon, try a draw, docs, committee (`cd web && npm i && npm run dev`) |
| `device/` | the `vrf@1.0` HyperBEAM device: patch, sources, rollout gates |
| `vendor/` | JSON and HyperBEAM client from paralith-mono (see `vendor/SOURCE`) |

## Test

```bash
npm install
npm test                # local: AOS wasm (set AOS_WASM) + BLS
npm run test:live       # the same Lua suites on a live node's Luerl
```

## License

MIT
