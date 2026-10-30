# Plan: hyper-parallel randomness

Status: draft, 2026-10-30. Measured numbers come from soak run 10 (step-load test).

## Summary

Beacon rounds do not limit randoms per second. One round signature serves every
request waiting for that round, and each request gets its own value
`sha256(roundValue | requester | requestId)`. The real ceiling is message handling:
every request is a message that one beacon process on one HyperBEAM node must
verify, schedule, compute, store and push.

To scale without limit, take requests off the beacon:

1. **One beacon, unlimited consumers.** The beacon publishes round signatures only.
   Consumers derive their randoms locally and anyone can verify them.
2. **Sharded beacons.** Where request accounting must stay on a beacon, run N shards
   signed by one committee with one group key.
3. **Spread across nodes.** Put consumers and shards on many HyperBEAM nodes, so
   capacity adds up linearly.

## How it works today

- **Rounds.** The committee (2-of-3 threshold BLS) signs round `r`; the beacon
  verifies the aggregate and stores `value = H(signature)`. The minimum gap between
  rounds is 500 ms; in practice a round takes about 1 s (collecting partials).
- **Batching.** A round serves all requests pending for it, in one message, with one
  signature check. Each requester gets one `RNG-Result` carrying all its values.
- **Count.** A consumer can ask for several randoms in one request.
- **Cost per request.** About 10 ms of Lua in the beacon, plus the node's work per
  message: signature verify, scheduling, state write, push to the consumer.

## Measured (run 10 step-load, one node, 4 vCPU)

| Run | Request rate | Randoms delivered/s | Latency p50 / p95 | Node messages/s | HyperBEAM CPU | Result |
|---|---|---|---|---|---|---|
| 10a (before fix) | 6/s | 6.0 | 1.5 s / 2.3 s | 24 | 300–350% | clean |
| 10a (before fix) | 12/s | 1–3 | 21 s / 44 s | 10–13 | 180% | flooded in 4 min |
| 10b (sharded guards) | 6/s | 6.3 | 1.4 s / 2.0 s | 25 | 250–340% | clean |
| 10b (sharded guards) | 12/s | 10–12.8 | 1.5→7.8 s / 2.2→22 s | 33 | 350% | delivers, latency creeping up |
| 10b (sharded guards) | 24/s | 5–7 | 38 s / 105 s | 18–25 | 200% | flooded in 3 min |

**Why it floods: a beacon process is single-threaded, and its cost per message grew
with load.** Flooding starts when one beacon process needs more than one core's worth of
Lua time. Once it falls behind, its queue grows, pushes back up (p95 above 40 s), and HyperBEAM
CPU drops: work waits on the one busy process instead of using the free cores.

- **Before the fix (run 10a):** every Request-Random re-encoded the whole duplicate guard
  (`seen`, 10 minutes of request ids, 452 KB). Lua time per request rose from about 10 ms to
  364 ms, and the quick beacon saturated between 6 and 12 requests/s.
- **After the fix (run 10b, commit 92ca82e):** request ids are published in small shards,
  and each request rewrites only its shard. Quick beacon Request-Random fell to 54 ms
  and throughput doubled to about 12 randoms/s.
- **First bottleneck now: the time-lock beacon.** At 12 requests/s it used 77% of one core
  (Request-Random 106 ms, Reveal 154 ms, Commit 77 ms per message). The quick beacon used
  60% of one core. Both still JSON-encode their whole state and run a full garbage
  collection on every message, so the cost per message still grows with state size.
- **Node CPU** is the second limit: about 3.5 of 4 cores at 12 requests/s.

**Next fixes, by expected gain:**

1. Publish state incrementally: only changed fields or per-key results, never the whole
   state per message. Drop the full `collectgarbage("collect")` per message.
2. Design 1 below: requests leave the beacon entirely, which removes this ceiling.
3. Shards (Design 2) and more nodes (Design 3) for whatever per-process limit remains.

## Design 1: one beacon, unlimited consumers (largest win)

The beacon stops taking requests. It publishes each round and pushes it to subscribers.

- **Subscribe once.** A consumer process sends `Subscribe` (paid per round or per
  epoch). The beacon pushes each round `{r, signature, value}` to every subscriber;
  later, subscribers can re-push to their own subscribers as a fan-out tree.
- **Derive locally.** A consumer commits to a future round `r` for each draw, then
  computes `sha256(value_r | consumerId | drawId | i)` for as many values as it needs.
  It needs no beacon message per draw.
- **Verify anywhere.** Anyone checks the BLS signature of round `r` against the group
  key (once per round, cached), then recomputes the hash.
- **Safety.** A draw must name its round before the round exists (the commitment is in
  the consumer's own message history), so nobody can pick a favourable round.
- **Throughput.** Randoms/s = consumers × draws per consumer per round. The beacon's
  load is one message per round per direct subscriber, independent of demand.
- **Library.** The `rng` library gains `rng.draw(round, drawId, n)` and a round cache.

## Design 2: sharded beacons

For cases that need per-request accounting on a beacon (pay-per-request, refunds):

- Run N beacon processes `shard-0 … shard-(N-1)`. Clients pick a shard by
  `hash(address) mod N`, or any shard.
- **One committee, one key.** Members sign `shardId | round`; daemons subscribe to all
  shards. A partial signature costs about 1 ms, so one committee can serve hundreds of shards.
- **Cheaper variant.** Members sign one round for all shards; each shard verifies the
  signature once and serves its own requests. N shards cost the committee nothing extra.

## Design 3: spread across nodes

- AO processes are independent, so shards and consumers can live on different
  HyperBEAM nodes. Capacity grows with nodes.
- Needs the multi-node scheduling work (roadmap step 5) and push between nodes.

## Plan

1. **Finish the step-load test.** Record the max clean randoms/s and the first
   bottleneck. Verify: steps.log shows the saturation point; correctness checks clean.
2. **Spec Design 1.** Round push, Subscribe, draw commitment, derivation, verification.
   Verify: SPEC.md section reviewed.
3. **Build Design 1.** Push of rounds to subscribers in `beacon.lua`, `rng.draw` in
   the library, and a consumer example. Verify: unit tests and a live test where 100
   consumers draw 1,000 randoms per round each.
4. **Load-test Design 1.** Same step test, randoms counted at the consumers. Target:
   at least 10,000 randoms/s on one node, limited by consumer count, not the beacon.
5. **Shard if needed** (Design 2), then spread across nodes (Design 3).

## Risks and open questions

- **Push fan-out cost.** Pushing to many subscribers per round is N messages per round;
  a fan-out tree or pull-on-demand may be needed above a few hundred subscribers.
- **Commit-before-round** must be enforced by the consumer library; a consumer that
  derives from an already published round can choose its outcome.
- **Fees.** Paying per round subscription instead of per request changes the token
  economics for validators.
- **Node overhead.** Per-message cost dominates today; HyperBEAM-side optimizations
  (batch signature verify, cheaper store writes) help every design.
