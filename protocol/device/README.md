# timelock@1.0: the HyperBEAM device

Stateless, deterministic checks the beacons run on the node, so verifying a
round is one call instead of a fleet of verifier processes:

| Key | Inputs | Returns |
|---|---|---|
| `verify-reveal` | `c`, `alpha`, `h` | `valid`, `y`: checks `g^alpha = c` and returns the canonical output `h^alpha` (SPEC 2.4) |
| `verify-crack` | `x`, `t`, `y`, `proof` | `valid`, `y`: a cracked output with its Wesolowski proof, canonical (SPEC 2.5) |
| `generator` | none | `g`, `n`: the built-in RSA-2048 modulus and generator (SPEC 2.3) |
| `verify-bls` | `public-key`, `message`, `signature` | `valid`, `value`: the quick tier's committee signature |
| `derive` | `seed`, `counter`, `bytes` | `value`: SHA-256 counter-mode bytes |

Hex must be lowercase without leading zeros. Every puzzle lives mod the
RSA-2048 challenge number, whose factors nobody knows, so neither a validator
nor a cracker can forge an output. BLS uses
[blst](https://github.com/supranational/blst) v0.3.16 in a dirty-scheduler NIF.
Full reference: `timelock-at-1-0.md`.

From a Lua process:

```lua
local status, res = ao.resolve({ path = "/~timelock@1.0/verify-reveal", c = c, alpha = alpha, h = h })
-- res.valid == true, res.y is the canonical output
```

## Where the code lives

The device compiles into the node, so it is built in our HyperBEAM fork. This
folder is the canonical copy:

- The device ships in `paralith/v0.11` (BLS device and first time-lock keys).
  `timelock-device.patch` is our change on top of it, made against
  `paralith/v0.11` @ `f5a683ecd`: one unknown-order modulus and sound cracks.
- `dev_timelock.erl`, `blst_nif.erl`, `blst_nif.c`: the sources, for reading.
- Test vectors come from `test/gen-vrf-vectors.mjs` (BLS) and `test/gen-timelock-vectors.mjs` (time-lock).

Apply to a HyperBEAM checkout, then test in Docker:

```bash
git am /path/to/rng/device/timelock-device.patch
git submodule update --init native/lib/blst native/lib/secp256k1
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
