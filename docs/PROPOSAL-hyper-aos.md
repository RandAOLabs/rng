# Proposal: safe randomness in hyper-aos

**Ask:** bundle the `rng` library in hyper-aos so every process gets a safe
`math.random` and `require("rng")` out of the box. The patch is ready:
[`hyper-aos-rng.patch`](hyper-aos-rng.patch) (5 files, 2 new tests, full
suite 187/187).

## The gap today

- HyperBEAM v0.11-RC7 sandboxes `math.random` (with `os.time`, `os.clock`,
  `os.date`) for processes, correctly: its value depends on the node, so two
  nodes or a replay compute different results and the process forks.
- hyper-aos does not replace it, so `math.random` inside a hyper-aos process
  raises an error. Games, raffles, matchmaking and sampling have no randomness.
- Legacy aos replaced it with a generator seeded once at spawn from public data
  (block height, owner, module, process id), so anyone can compute every roll.

## What the patch does

1. Bundles `rng.lua` (pure Lua 5.3, MIT, no dependencies) as a hyper-aos module.
2. Before each message, points `math.random` at a SHA-256 stream seeded from
   that message's id, slot and timestamp. Every node and every replay draws the
   same numbers; different messages draw different ones. Existing code that
   calls `math.random` works again unchanged.
3. Makes `require("rng")` available, so a process can step up when a draw is
   worth attacking:

```lua
rng.request(msg, { tier = "local",    on = "Roll" })  -- free, in the same message
rng.request(msg, { tier = "quick",    on = "Roll" })  -- 2-of-3 committee signature, ~1 s
rng.request(msg, { tier = "timelock", on = "Roll" })  -- any-one-honest time-lock round, ~1 s
```

The local tier is honest about its limit: the sender of a message could
re-sign until it likes the roll. That is fine for cosmetics and tie-breaks and
it is why the verifiable tiers exist.

## The verifiable tiers

- **Time-lock (flagship):** every validator commits a time-lock puzzle, then
  reveals it with the puzzle's factor; a silent validator is cracked with a
  Wesolowski proof. One honest validator keeps the draw unpredictable.
- **Checked on the node:** the `timelock@1.0` HyperBEAM device verifies a reveal
  in ~1.4 ms and a crack in ~0.7 ms (2048-bit, 2^27 squarings). It is
  stateless and holds no keys or fees; we will propose it upstream.
- **Live numbers (isolated RC7 test network):** time-lock rounds finalize in
  0.6-1.0 s with 3 validators; a 3-day soak with 50 wallets, up to 100
  contracts and validators knocked offline on purpose is running now.

## What it costs hyper-aos

- ~330 lines of Lua in the bundle, no new dependencies, no network calls for
  the default path.
- One line in `process.handle`.
- No behaviour change for processes that never call `math.random` or `rng`.

## Links

- Code, spec, paper: <https://github.com/RandAOLabs/rng>
  ([SPEC.md](../SPEC.md), [paper/](../paper))
- Device: [`device/`](../device)
