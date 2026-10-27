# timelock@1.0: the HyperBEAM device

Stateless, deterministic checks the beacons run on the node, so verifying a
round is one call instead of a fleet of verifier processes:

| Key | Inputs | Returns |
|---|---|---|
| `verify-reveal` | `modulus`, `seed`, `t`, `y`, `p` | `valid`, `x`: a time-lock answer opened with its factor (SPEC 2.4) |
| `verify-crack` | `modulus`, `seed`, `t`, `y`, `proof` | `valid`, `x`: a cracked answer with its Wesolowski proof (SPEC 2.5) |
| `derive-x` | `modulus`, `seed` | `x`: the round's puzzle input |
| `verify-bls` | `public-key`, `message`, `signature` | `valid`, `value`: the quick tier's committee signature |
| `derive` | `seed`, `counter`, `bytes` | `value`: SHA-256 counter-mode bytes |

Hex must be lowercase without leading zeros. Measured at 2048 bits and
t = 2^27: verify-reveal 1.4 ms, verify-crack 0.7 ms. BLS uses
[blst](https://github.com/supranational/blst) v0.3.16 in a dirty-scheduler NIF.
Full reference: `timelock-at-1-0.md`.

From a Lua process:

```lua
local status, res = ao.resolve({ path = "/~timelock@1.0/verify-reveal",
  modulus = N, seed = beaconId .. "|" .. round .. "|" .. validator, t = "134217728", y = y, p = p })
-- res.valid == true
```

## Where the code lives

The device compiles into the node, so it is built in our HyperBEAM fork. This
folder is the canonical copy:

- `timelock-device.patch`: the whole change (two commits: BLS device, then the time-lock
  keys and the rename), made against `paralith/v0.11` @ `58b3d2b32`.
- `dev_timelock.erl`, `blst_nif.erl`, `blst_nif.c`: the sources, for reading.
- Test vectors come from `test/gen-vrf-vectors.mjs` (BLS) and `test/gen-timelock-vectors.mjs` (time-lock).

Apply to a HyperBEAM checkout, then test in Docker:

```bash
git am /path/to/rng/device/timelock-device.patch
git submodule update --init native/lib/blst
scripts/timelock-test.sh   # builds in erlang:27 and runs dev_timelock + dev_lua tests
```

## Rollout gates (proposed)

Nothing moves to the next step until the one before it passes.

1. **Build.** The patch applies on the finished RC7 port; `timelock-test.sh` passes;
   the full eunit suite and the release image build.
2. **Our nodes.** Roll the image to all 3 committee nodes; switch the testnet
   beacon to `useDevice: true` with one `Configure`.
3. **Soak.** A load script drives rounds continuously. Pass when: a week with
   no missed or wrong round, every finalized signature re-verified off-chain,
   request-to-result latency within one cadence plus 2 s at p95, and rounds
   keep finalizing with one node stopped and after each node restarts.
4. **Paralith.** Only then is it offered to the games, non-critical draws
   first; critical draws after a second clean soak period.
