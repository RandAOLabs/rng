# Live smoke test

`deploy/smoke.mjs` drives a deployed RNG v3 end to end through the client code
third parties use: `lib/js` (fair-client, history), `validator/vendor`
(hbclient httpsig, ans104 wallet signing), `validator/anyhonest.mjs` and
`validator/bls.mjs` for verification.

```sh
HB_NODE=https://hyperbeam.tylerw.ai HB_WALLET=/path/to/wallet.json RNG_STATE=deploy/v3-mainnet.json \
  node deploy/deploy.mjs smoke --n 50 --load 100 --fast-load 100 --games 3
```

Options: `--n` runs per scenario (default 10), `--only A,B,...`, `--load` and
`--fast-load` (burst sizes, default 30), `--games` (parallel fair-play games,
default 3), `--cap` (RNG, at most 10,000).

| | Scenario |
|---|---|
| A | Any-Honest pay-and-request from a wallet (ANS-104); round re-verified locally and with `~rng@1.0` |
| B | Any-Honest prepaid: deposit, signed Request-Randoms at the deposit price, leftover withdrawn |
| C | A spawned consumer process (`protocol/test/request-consumer.lua`) gets the RNG-Result push |
| D | Fast tier pay-and-request and prepaid: BLS group signature, value and request derivation |
| E | Fair play: several games in parallel, throwaway player keys, reveal and one forfeit |
| F | Negatives: replayed signed Transfer and Request-Random, reused id, no balance, malformed, dust |
| G | Any-Honest burst: all served, validators fault-free, beacon on pace (1.8-2.2 rounds/s) |
| H | Fast-tier burst: all signed, nothing left pending |

Output: a table on stdout and `deploy/smoke-reports/<timestamp>.json`.

## Safety

Every message passes `guard()`. It writes only to the token, beacon, fast tier,
fair process and processes the run spawned. It never sends Gov.*, DAO, Exit,
bond, stake or claim messages. Transfers go only to the beacon, fast tier or
fair process, and the run aborts before a Transfer that would pass the cap.
Leftover beacon and fast-tier balances are withdrawn at the end. Extra fair
games are processes the run spawns (`protocol/test/fair-game.lua`), and their
leftover is withdrawn to the game process.

## Governance and bond tests (planned, not run)

`node deploy/smoke.mjs --gov-plan` prints the plan (`GOVERNANCE_PLAN` in the
script). None of it runs today, and it must never run against the live DAO,
beacon, fast tier or fair process. It needs its own deployment, spawned for the
purpose with its own state file (for example `RNG_STATE=deploy/v3-govtest.json`),
a test DAO and dedicated test validator keys. A runner for it must refuse unless
every target pid differs from `deploy/v3-mainnet.json`'s, and its guard must allow
only those pids.

- GOV-1, harmless DAO action: stake, propose Gov.Pause, vote, finalize; the
  beacon applies it on receipt; then Gov.Resume the same way.
- GOV-2, money action with Effective-At: Gov.Treasury-Spend. It is refused
  without Effective-At or with one that is too early. Once it passes it shows in
  govPending with the hatch open. Gov.Apply is refused before it is due, applies
  once after, and a second Gov.Apply is refused.
- GOV-3, exit hatch: while GOV-2 is pending, a test validator sends Exit-Now and
  gets its bond back once its owed rounds settle. A payer withdraws during that
  time. A fast-tier test member sends Exit-Now and gets its accrued fees.
- GOV-4, bond, rejoin, slash cooldown: a test validator bonds to the full stake,
  and a bond below the stake is refused. It goes Ready and runs rounds. It then
  misses a reveal: the round is cracked, the validator is slashed and the
  crackBounty is paid. Its rejoin backoff doubles from rejoinBaseMs up to
  rejoinCapMs. On Exit its bond comes back after its rounds settle, and a re-bond
  is refused while Exit-Settling.
- GOV-5, Remove-Validator: a DAO proposal with Effective-At. After Gov.Apply the
  validator is gone, its bond is refunded, and rounds keep finalizing.
- GOV-6, treasury cap: a spend above `treasuryWindow.remaining` is refused.
  Spends within it add to `used`, and the window resets after `windowMs`.
