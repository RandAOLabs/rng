# vrf@1.0: the HyperBEAM device

Lets the beacon check a round's BLS signature on the node itself, so one
signed post finalizes a round instead of two matching attestations. Stateless
and deterministic: every node computes the same answer.

| Key | Inputs | Returns |
|---|---|---|
| `verify-bls` | `public-key` (48-byte G1, hex), `message`, `signature` (96-byte G2, hex) | `valid`, and `value` = SHA-256("round\|" .. signature) when valid |
| `derive` | `seed`, `counter`, `bytes` (≤ 1024) | hex of SHA-256(seed .. counter + k) blocks |

BLS12-381 minimal-pubkey scheme, hash-to-curve DST
`BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_`, subgroup-checked points, via
[blst](https://github.com/supranational/blst) v0.3.16 in a dirty-scheduler NIF.
Full reference: `vrf-at-1-0.md`.

From a Lua process:

```lua
local status, res = ao.resolve({ path = "/~vrf@1.0/verify-bls",
  ["public-key"] = groupKey, message = beaconId .. "|" .. round, signature = sigHex })
-- res.valid == true
```

## Where the code lives

The device compiles into the node, so it is built in our HyperBEAM fork. This
folder is the canonical copy:

- `vrf-device.patch`: the whole change (device, NIF, blst submodule, build
  hooks, eunit vectors, docs), made against `paralith/v0.11` @ `b5387693d`.
- `dev_vrf.erl`, `blst_nif.erl`, `blst_nif.c`: the sources, for reading.
- Test vectors come from `test/gen-vrf-vectors.mjs` (the beacon's own BLS code).

Apply to a HyperBEAM checkout, then test in Docker:

```bash
git am /path/to/rng/device/vrf-device.patch
git submodule update --init native/lib/blst
scripts/vrf-test.sh        # builds in erlang:27 and runs dev_vrf + dev_lua tests
```

## Rollout gates (proposed)

Nothing moves to the next step until the one before it passes.

1. **Build.** The patch applies on the finished RC7 port; `vrf-test.sh` passes;
   the full eunit suite and the release image build.
2. **Our nodes.** Roll the image to all 3 committee nodes; switch the testnet
   beacon to `useDevice: true` with one `Configure`.
3. **Soak.** A load script drives rounds continuously. Pass when: a week with
   no missed or wrong round, every finalized signature re-verified off-chain,
   request-to-result latency within one cadence plus 2 s at p95, and rounds
   keep finalizing with one node stopped and after each node restarts.
4. **Paralith.** Only then is it offered to the games, non-critical draws
   first; critical draws after a second clean soak period.
