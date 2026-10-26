# Soak test

Many wallets and contracts use the beacon in different ways for days; a
checker re-verifies everything and keeps a pass/fail report.

- `consumer.lua`: a game-like contract built on `lib/rng.lua` (local and beacon draws, results, errors).
- `run.mjs`: the driver. Wallets play contracts, request directly, send duplicates and unfunded
  requests (which must be refused), withdraw and top up. Steady rate with a ramp, hourly bursts,
  new contracts every 30 min next to the old ones, and chaos: one committee node stopped for
  10 min every 6 h (needs `deploy/nodes.local.sh`).
- `check.mjs`: verifies every round's BLS signature and value, every contract result and die,
  that refusals held, fees add up, nothing is lost or stalled; latency and dice uniformity.
  Writes `data/report.md`.

```bash
export HB_WALLET=owner.json          # token/beacon owner: mints soak funds
node soak/run.mjs &                  # defaults: 50 wallets, 100 contracts, 1 action/s, 72 h
node soak/check.mjs                  # report in soak/data/report.md
```

Pass (72 h): no bad rounds, no wrong results, no lost requests, refusals held, no stall over
3 cadences, p95 request-to-result within cadence + 2 s, dice uniform.
