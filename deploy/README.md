# Native testnet operations

`native-testnet.json` is the canonical public process inventory of what is
live: token, the old threshold process (fast tier, v2), Any-Honest beacon (v2, `MZMoXv-2`), committees,
validators and DAO. `deploy.mjs` never writes it. v3 deploys record into
`v3-testnet.json` (`RNG_STATE`) until the cutover below merges them in.

The HyperBEAM node is recreated through `compose.hyperbeam-stage.yaml`. Its
process cache, node key, and node configuration are host-mounted, so changing
the runtime image does not discard proposals, stakes, votes, beacon state,
balances, or historical process implementation IDs.

Promote a tested runtime under the stable tag, then recreate it:

```bash
docker tag runerealm-hb:<candidate> runerealm-hb:rng-current
docker compose -f /opt/hyperbeam-rng-stage/compose.yaml up -d --force-recreate
curl -fsS -H 'Accept: application/json' \
  https://randao.net/hb-stage/~rng@1.0/generator
curl -fsS https://randao.net/api/anyhonest
curl -fsS https://randao.net/api/dao
```

Keep the previous container and image until the device, beacon, DAO, console,
validators, and authenticated subscription path have all been verified.

## History and rebuilding state

The processes keep only a bounded recent window (docs/PERMISSIONLESS.md,
"State bounds"). Nothing older is lost: HyperBEAM keeps every slot's state
and results, so any key can be read as of any slot:

```bash
NODE=https://randao.net/hb-stage
curl -fsS -H 'accept: application/ao' "$NODE/<pid>~process@1.0/now/at-slot"            # latest slot
curl -fsS -H 'accept: application/ao' "$NODE/<pid>~process@1.0/compute&slot=1234/beaconround"
curl -fsS "$NODE/<pid>~process@1.0/compute&slot=1234/results/output/data"              # that slot's reply
```

- Index: `beaconhistory` (Fast), `timelockhistory` (Any-Honest) and
  `fairhistory` (fair) list the last 1024 rounds / sessions as `[id, slot]`
  (`"abandoned"` third for an abandoned round).
- Past the index: binary-search slots `1..at-slot` for the first whose
  `beaconinfo.round >= R`; the round's record is there (`beaconround`,
  `beaconround-<R%8>`, or `beaconabandoned`). An Any-Honest round cracked late
  finalizes a few slots after later rounds: scan forward from that slot.
- Helpers: `validator/history.mjs` (`httpReader`, `findRound`, `indexLookup`)
  and `lib/js/history.ts`; the console's `getNetworkStatus(round)`,
  `findAnyHonestRound(round)` and `FairClient.history(...)` use them.

To audit, replay slots `1..N` and recompute each round from its own record
(Fast: BLS-verify `signature` on `message` under `groupKey`; Any-Honest: verify
each output on `~rng@1.0`, then the value hash). To rebuild a process's state,
read `compute&slot=N/<state key>` (`beaconstate` + `beaconhistory`;
`timelockstate` + `timelockguards` + `timelockseen-*` + `timelockhistory`;
`fairstate`; the token's `balances`/`transferstreams`): restore() takes exactly
these keys. Files in `snapshots/` (e.g. the token balances at a time) are such
reads saved for a cutover; a successor process starts from its own genesis, not
from them.

## Any-Honest cracker

Its own container, separate from HyperBEAM, pinned to one core the node does not use (on a shared host the node runs on cores 1-15, daemons on core 0).
It works on a late round until the beacon's published `abandonAt`: a round every validator committed to waits for its crack (up to 7 days) while the Treasury can pay the bounty.

```bash
docker build -t rng-cracker -f validator/Dockerfile.cracker .   # from the repo root
mkdir -p /opt/rng-cracker && echo '{"beacon":"<anyHonest>","hbNode":"https://hyperbeam.tylerw.ai","dataDir":"/data","listen":7479}' > /opt/rng-cracker/config.json
docker run --rm -v /opt/rng-cracker:/data rng-cracker init /data/config.json   # prints its address
docker run -d --name rng-cracker --restart unless-stopped --cpuset-cpus=0 --network host   -v /opt/rng-cracker:/data rng-cracker run /data/config.json
docker run --rm -v /opt/rng-cracker:/data rng-cracker claim /data/config.json  # withdraw bounties
```

Before stopping a validator node, create `pause` in its `secrets-dir` and wait
for `ready: false` in `/~rng-validator@1.0/status`; a ready validator stopped
without pausing is slashed for every round it does not finish.

## deploy.mjs (v3)

The command list is the header of `deploy.mjs`. Config templates:

| File | What |
| --- | --- |
| `v3-genesis.json` | genesis allocations (whole RNG or atoms, `$DEPLOYER` allowed; must sum to exactly 10^15 atoms): all of it to RNG Labs, plus the `distribution` the runbook transfers on |
| `v3-params.json` | genesis `Gov.Configure` parameters and `predecessor`; checked against the beacon's hard bounds before sending |
| `anyhonest-h.json` | `h`, `hProof` for `T` |
| `anyhonest-validators.json` | validator wallets for `bond-for` |
| `proposals/*.json` | DAO proposal templates (`dao-propose`, placeholders `$BEACON`, `$SUCCESSOR`, ...) |

`--dry-run` prints every spawn and message as JSON and sends nothing.
`node deploy/deploy.mjs plan --dry-run` prints the whole sequence below.
Every spawn pins one scheduler (the node's), and `genesis-configure`,
`configure-fair` and `set-dao` refuse processes recorded on another one: the
beacon believes the DAO and the token only through its own scheduler's
`from-process`.

## Launch prerequisites

- **Scheduler dedupe.** The node must assign a signed message at most once
  per process (409 "Message already scheduled." on a copy;
  `dev_scheduler_server` `write_assignment`, paralith/v0.11 lineage). The old
  prod-stage source lacks it. The processes take no user time and rely on it
  for replay protection; their own 10-minute request-id windows (scheduler
  time) are only belt and braces.

## Owners

The beacon, fair play and the fast tier carry `protocol/vendor/gov.lua`
(paralith-mono's, extended with Effective-At and the exit hatch;
`protocol/vendor/SOURCE`). The launch wallet bootstraps them, then in the same
step hands them to the RNG DAO and renounces: after launch the DAO is the
only owner and the wallet has no powers. docs/PERMISSIONLESS.md, "Governance
at launch", is the plain statement of the rules; in short:

- **DAO-only.** `dao-handover --confirm` sends `Gov.Set-Dao` and then
  `Gov.Renounce-Wallet` to every deployed protocol and reads back
  `gov.dao = <DAO>` and `gov.wallet = false` on each (`plan` does this).
  `set-dao` and `renounce-wallet <role> --confirm` are the two halves, for a
  protocol deployed on its own.
- **Labs' stake.** RNG Labs stakes 50,000,000 RNG (`dao-stake`, default
  `LABS_STAKE_RNG`; `RNG_LABS_STAKE` or an amount overrides it). That is the
  majority of the stake at launch: Labs decides votes only while no coalition
  stakes more. The rest of Labs' allocation stays liquid, meant to be sold to
  the public over time or moved to the reserve or treasury, so control
  spreads as RNG is sold. Labs can add stake if it needs to.
- **Votes take 1 day** (`Voting-Period` 86,400,000 ms, the lowest stake-dao/1
  allows; it can only be raised).
- **Money and code wait 24 h.** A proposal that moves money or code carries
  `Effective-At` (`dao-propose` fills `$EFFECTIVE_AT` = the vote's end + 24 h
  + 1 day, and refuses one earlier than the vote's end + 24 h). The protocol
  refuses less than 24 h after receipt, stores it in `govPending`, and anyone
  applies it once due: `gov-apply <beacon|fair|fast> <Gov-Id>`. The DAO
  cancels with `016-cancel.json`. Code: `010-approve-code.json`, then anyone
  uploads with `Gov.Upgrade`; it installs from `Effective-At` on.
- **Exit hatch.** While one waits, validators `Exit-Now` (bond back at once)
  and payers withdraw.
- **No instant fix.** The fastest brake is `009-pause.json`, a 1-day vote; the
  fastest money or code change is 1 day + 24 h.

Owners and the queue are published as `gov` and `govPending` in
`beaconinfo` / `fairinfo` and kept in the process state, so a rebuilt VM
never re-arms a renounced wallet or loses a pending action. The token is
never governed.

## Fresh deploy (2026-11-07)

New token (`RNG`, no `TEST-`), new DAO (`RNG DAO`), no predecessor
(`v3-params.json` `predecessor: ""`), the whole supply to the deployer
(`allocations-deployer.json`).

```bash
export RNG_STATE=deploy/v3-main.json PARALITH_MONO=/c/REPO/pm-dao HB_NODE=$NODE HB_WALLET=<deployer.json>
node deploy/deploy.mjs plan deploy/allocations-deployer.json --dry-run
node deploy/deploy.mjs spawn-token deploy/allocations-deployer.json && node deploy/deploy.mjs spawn-dao --lua53b
node deploy/deploy.mjs spawn-beacon && node deploy/deploy.mjs genesis-configure
node deploy/deploy.mjs fund-reserve && node deploy/deploy.mjs fund-treasury
node deploy/deploy.mjs spawn-fair && node deploy/deploy.mjs configure-fair && node deploy/deploy.mjs fund-fair 40
node deploy/deploy.mjs bond-for 100000 deploy/anyhonest-validators.json
node deploy/deploy.mjs spawn-fast && node deploy/deploy.mjs genesis-configure-fast
node deploy/deploy.mjs dao-stake                    # Labs: 50,000,000 RNG
node deploy/deploy.mjs dao-handover --confirm       # set-dao + renounce-wallet on all three, read back
node deploy/deploy.mjs verify                       # includes "<role> wallet renounced"
```

## Launch runbook (testnet cutover)

```bash
# from the repo root
export HB_NODE=https://hyperbeam.tylerw.ai HB_WALLET=<deployer.json> \
  RNG_STATE=deploy/v3-testnet.json PARALITH_MONO=/c/REPO/paralith-mono
node deploy/deploy.mjs plan --dry-run      # review every message first
```

1. **Token.** `spawn-token deploy/v3-genesis.json`: the whole supply,
   1,000,000,000 RNG, goes to RNG Labs (`$DEPLOYER` on testnet). Check:
   `status` shows sealed, supply 10^15, `sequenced-v1`.
2. **DAO.** `spawn-dao` (YapDAO `stake-dao/1` from paralith-mono, `Dao-Token` =
   RNG, rules from `daoRules()`, same scheduler). It refuses a token without
   `sequenced-v1` and checks `daoinfo` (configured, token, no admin).
3. **Beacon v3 genesis.** `spawn-beacon`, then
   `genesis-configure deploy/v3-params.json`. This locks token, unit, self and
   `predecessor = ""` (`v3-params.json`: a fresh deploy has no predecessor;
   the v2 beacon `MZMoXv-2` is legacy, its reserve is in the old TEST-RNG and
   it is retired, step 7).
4. **250 M under DAO control.** `fund-reserve` (200 M) and `fund-treasury`
   (50 M) from Labs into the beacon. This is the DAO's share: the DAO process
   itself must never receive RNG, because stake-dao/1 can never send an action
   to the token it stakes (paralith-mono `dao.lua:193`), so RNG sent there is
   unspendable. The DAO controls both through `Gov.*`: the reserve pays
   heartbeat rounds (and moves only to a successor), the treasury is
   spendable by the DAO (`Gov.Treasury-Spend`, 24 h after the vote, at most
   10 % of the treasury in any rolling 30 days with reserve funding), and can top up
   the reserve (`Gov.Fund-Reserve`). Every `fund-*` refuses until
   `beaconinfo.token` is set (step 3): before genesis the beacon can only
   refund the Credit-Notice through its sender, and past 16 senders or 256
   notices each the atoms strand.
   **Fair play** (open to any game): `spawn-fair`, `configure-fair` (beacon,
   token, `requestPrice` from `v3-params.json`), `fund-fair 40` (the fair
   process's beacon float, 10 requests; it is topped up from the games after
   every batch, never spent). Each game prepays its own draws:
   `fund-game <rng> <game>` (or any Transfer to the fair process with
   `X-Fair-Game = <game>`); an unfunded game gets `Game-Unfunded`, and a game
   takes back its free balance with `Fair.Withdraw { Nonce }`. Re-run
   `configure-fair` before the handover; after it the DAO changes both prices
   by proposal (`002-configure.json` and `015-fair-configure.json`; prices
   are harmless, applied on receipt: balances keep their deposit price).
5. **Validators bond and migrate, after step 9.** Bonding waits for
   `dao-handover`: validators bond only once the wallet is renounced (`plan`
   runs `bond-for` after it). Each launch validator receives 100,000 RNG
   and bonds all of it (4 x stake, the rank cap) in one transfer:
   `bond-for 100000 deploy/anyhonest-validators.json`. At the cap from day
   one, a newcomer must bond as much to outrank them (a quarter of the seats
   go by seniority whatever the bond). A launch validator outside that file
   gets `grant <address> 100000` and bonds at least 25,000 itself (100,000 to
   match the operators). Third parties run
   `node validator/anyhonest-validator.mjs init`, get RNG, then `bond` and
   `run`. The in-node devices need the v3-aware `rng-validator@1.0` (WP5)
   build first. Check `status` and `test-subscription` once they run (after
   step 9); a problem then is fixed by DAO proposal only.
   A later allocation for Paralith contracts' RNG is a plain `grant`, not
   part of launch.

   *Runway.* The runway is how long
   the reserve keeps paying heartbeat rounds: 200 M RNG at 2 rounds/s x
   1 RNG (172,800 RNG/day) is about 1,157 days (3.2 years), extendable by
   `Gov.Fund-Reserve` from the treasury; after it the beacon falls back to
   request-driven rounds.
6. **Successor on the old beacon (legacy Admin path).** With the v2 owner wallet:
   `RNG_LEGACY_STATE=deploy/native-testnet.json node deploy/deploy.mjs legacy-set-successor MZMoXv-2aLD1MaR5tHEpXNrZgc6DoUpdw2q4DvlfxC0 <v3 beacon>`.
   Devices pause there, finish their reveals and move to v3. Each validator
   then exits the old beacon (`anyhonest-validator.mjs exit --beacon MZMoXv-2...`,
   twice) to get its old TEST-RNG bond back.
7. **Reserve move: skip.** The v2 reserve is in the old TEST-RNG token
   (`Tk0E1Vfr...`). The v3 beacon refuses a Credit-Notice from another token
   and the atoms would be stranded, so `legacy-move-reserve` refuses when the
   successor uses a different token. The v3 reserve is the genesis allocation
   (step 4). The old reserve stays on MZMoXv-2 and is retired with the old
   TEST-RNG; old TEST-RNG balances keep no role in v3 and are not converted.
8. **Console and crackers.** Record the v3 token, DAO, beacon and fair in
   `native-testnet.json` (MZMoXv-2 and the advisory DAO to `retired`) and the
   console env (`site/deploy/native-testnet.env`) together, so
   `deploy/test/deployment-config.test.mjs` stays green. Point each cracker's
   `config.json` `beacon` at v3 and restart it.
9. **The DAO as the only owner.** `dao-stake` (Labs, 50,000,000 RNG), then
   `dao-handover --confirm`: `Gov.Set-Dao` and `Gov.Renounce-Wallet` on the
   beacon, fair play and the fast tier, each read back with `gov.wallet =
   false`. There is no guardian. `set-dao` refuses unless the DAO publishes a
   `stake-dao/1` `daoinfo` on our token with no admin, on our scheduler.
   Prove it: `dao-propose deploy/proposals/001-handover-proof.json` (a
   harmless re-set of `Request-Price`, applied on receipt), `dao-vote <id>
   Yes`. After the 1-day vote the DAO executes it; check the proposal is
   `executed` with no `Not authorised` refusal. Then `verify` (includes
   "owned by the DAO", "wallet renounced" and "runs the recorded build").
   `dao-handover` refuses unless every protocol's `govPending` is empty,
   nothing is approved, `gov.code`/`gov.version` are the build `spawn`
   recorded, and the DAO is a configured `stake-dao/1` on our token. Then
   step 5 (bonding). From now on run `dao-watch` at least once a day (cron):
   it lists every open proposal, flags any Labs has not voted on, and every
   pending action; it exits 1 when one needs a look. Labs votes on every
   proposal while its stake decides (docs/PERMISSIONLESS.md "Who governs the
   DAO").

**Fast tier (step 8b, before the handover).** On-demand 2-of-3 threshold BLS on
the existing committee; no heartbeat, rounds open only for paid requests.

```bash
node deploy/deploy.mjs spawn-fast
node deploy/deploy.mjs genesis-configure-fast deploy/committee.json   # v3 token, same DKG keys
node deploy/deploy.mjs fund-fast 30                                   # a test balance; then request
SSH_KEY=<committee key> deploy/nodes.sh install <app.tgz>           # daemon without the cadence gate (app/provider/ = validator/)
SSH_KEY=<committee key> deploy/nodes.sh beacon <fast pid>            # repoint the 3 rng-provider daemons
SSH_KEY=<committee key> deploy/nodes.sh start && deploy/nodes.sh status
```

Then set `RNG_BEACON_ID` in `site/deploy/native-testnet.env` and `beacon`
in `native-testnet.json` to the fast pid together. Retire the old threshold
process `iRWVCsShDNboHKSgXHe0_ZVZ89RhBdoRA0hU1wt468c`: it is unused and runs on
the dead token `qFXxcv...`, so move it to `retired` in `native-testnet.json`
(nothing to migrate; its balances are in the old TEST-RNG). The new process
publishes `nextRoundAt: 0`, so a daemon still on the old build keeps working;
the install only drops the dead cadence check. A committee change later is a
new DKG ceremony plus `012-fast-committee.json` (money: 24 h after the vote,
with the exit hatch open meanwhile).

**Verify after every step:** `node deploy/deploy.mjs status` (or `verify`,
which exits 1 on any failed check: sealed token, DAO on RNG with no admin,
beacon token/self/predecessor, health `ok`, reserve funded, owners (`gov`), fair
bound, one scheduler, and each protocol runs the recorded build:
`gov.code`/`gov.version` equal `state.expectedCode`). After the DAO installs
an upgrade, record it: `expect-code <beacon|fair|fast> <root> <version>`.
Validators: `anyhonest-validator.mjs status`.

**Cold restore (a rebuilt VM).** `GovState` comes back from the published
info key, but installed code lived in the old heap: a rebuilt VM runs the
**spawn module**. Its root comes back *approved* (`gov.approved = <root>`,
`gov.code = ""`), and `verify` fails "runs the recorded build" with "a cold
restore: resend the installed code". Recovery: resend the exact installed
bytes (`Gov.Upgrade`, one message or the manifest and its parts; anyone may,
paralith-mono `backend/native/gov-upgrade.mjs`). Until then the process runs
the spawn code over the restored state. Keep every installed bundle (and its
root) with the deployment state for this.

**Rollback**
- Before `dao-handover`: `gov Gov.Pause` stops the v3 heartbeat and new
  requests. Clear the old beacon's successor
  (`legacy-set-successor MZMoXv-2... ""`), re-point console and crackers to
  MZMoXv-2, which keeps running until retired.
- After it: only the DAO. It pauses by proposal (`dao-propose
  deploy/proposals/009-pause.json`, 1-day vote, on receipt; the fast tier takes
  the same proposal with `execProcess` `$FAST`). The fix is a new beacon voted
  in with `003-set-successor.json` (one vote + 7 days: it names where the
  reserve may go), or new code (`010-approve-code.json`, one vote + 24 h),
  then `gov-apply`. There is no faster path.
  Validators can `Pause`/`Exit` at any time and `Exit-Now` while a money/code
  action waits; governance can never take a bond.
