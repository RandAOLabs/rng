# Architecture (v3, live)

How RNG works today on AO mainnet (HyperBEAM). Process ids are from
[`deploy/v3-mainnet.json`](../deploy/v3-mainnet.json); rules are from the code in
[`protocol/`](../protocol/) and [`validator/`](../validator/). The design record is
[PERMISSIONLESS.md](PERMISSIONLESS.md); the paper is [whitepaper/](whitepaper/).
The abandoned January 2026 multi-chain design is in
[history/architecture-2026-01/](history/architecture-2026-01/).

## Processes

| Role | Process id | Code | Runs on |
|---|---|---|---|
| RNG token | `n7snPbrtwBA4LIlYMHHavzSZSrbUmheSLhw1uuX-KSY` | `protocol/token/rng-token.lua` | `lua@5.3a` |
| RNG DAO (YapDAO `stake-dao/1`) | `yAP3NXPHkz0m59Jm95iYlT6-qdqpBU50Cv9dwUBz6qk` | paralith-mono `dao.lua` (rules in `daoRules`) | `lua@5.3a` |
| Any-Honest beacon | `98AkinkWAtW2NM-csO-D1GNI-lJqf3xWbX-TgeupWUM` | `protocol/beacon/anyhonest.lua` | `lua-patch@1.0` |
| Fast tier | `NBpbTl643CXrRx3IIbN712O2_ZXbhbbFJZZhlcmOTsY` | `protocol/beacon/beacon.lua` | `lua@5.3a` |
| Fair play | `zEI8l8oaThgvIzd60ZyioW6TLZR10yKoeMTgp56TopE` | `protocol/fair/fair.lua` + `lib/fair.lua` | `lua@5.3a` |
| Subscription test consumer | `qxYgg3GQ0Tl4kwDAk3azOoWjHgK5upvk9-OeVjjgz2c` | `protocol/test/subscription-consumer.lua` | `lua@5.3a` |
| Scheduler (all of the above) | `tkqULqMDeHKXCN79Cm_bDIV560JxXl6pBSmdPgxqwSw` | HyperBEAM `scheduler@1.0` | main node |

Retired: Fast `VIsVLEi6…`, fair `QsKxU7KZ…` (replaced 2026-11-08). The beacon,
Fast tier and fair play are owned by the DAO only (`owners.*.walletRenounced`).

## System map

```mermaid
flowchart TB
  subgraph users["Users"]
    APP["Games and apps"]
    CON["randao.net console"]
    MKT["Paralith RNG/PUSD book"]
  end
  subgraph ao["AO processes, all on scheduler tkqU… (main node)"]
    TOKEN["RNG token n7sn…<br/>1B fixed, sequenced-v1"]
    DAO["RNG DAO yAP3…<br/>stake-dao/1"]
    FAIR["Fair play zEI8…"]
    AH["Any-Honest beacon 98Ak…<br/>reserve, treasury, bonds"]
    FAST["Fast tier NBpb…<br/>on-demand threshold BLS"]
  end
  subgraph nodes["3 HyperBEAM nodes: main, paralith, rng"]
    VAL["rng-validator@1.0<br/>3 Any-Honest validators"]
    PROV["rng-provider daemons<br/>2-of-3 Fast committee"]
    DEV["~rng@1.0 device"]
  end
  CR["Crackers (anyone)"]

  MKT -. "buy RNG" .-> APP
  APP -- "Transfer with X-Request-Id, X-For or X-Fair-Game" --> TOKEN
  CON -. "reads published keys" .-> ao
  TOKEN -- "Credit-Notice" --> AH
  TOKEN --> FAST
  TOKEN --> FAIR
  DAO -- "Gov.* per passed proposal" --> AH
  DAO --> FAST
  DAO --> FAIR
  FAIR -- "Request-Random" --> AH
  AH -- "RNG-Result" --> FAIR
  AH -- "RNG-Result" --> APP
  FAST -- "RNG-Result" --> APP
  FAIR -- "Fair-Result" --> APP
  VAL -- "Act, Ready, Pause" --> AH
  PROV -- "Partial, Round" --> FAST
  CR -- "Crack" --> AH
  AH -- "verify-reveal, verify-crack" --> DEV
  FAST -. "verify-bls (device mode)" .-> DEV
```

Every process believes another process only through a `from-process` that this
one scheduler signed (`actor()` in `anyhonest.lua`), so the token, DAO and
protocols all share it.

## Any-Honest round

Defaults from [`deploy/v3-params.json`](../deploy/v3-params.json). Rounds
overlap: round r+1 takes commits while r reveals.

```mermaid
sequenceDiagram
  autonumber
  participant P as Payer
  participant T as RNG token
  participant B as Any-Honest beacon
  participant V as Validators (active set)
  participant D as ~rng@1.0
  participant C as Cracker
  P->>T: Transfer to beacon, X-Request-Id (4 RNG)
  T->>B: Credit-Notice
  Note over B: request binds to the round taking commits (r)
  V->>B: Act { commit: { r, c = g^alpha mod N } }
  Note over B: first commit opens r, fixes its set (max 64),<br/>reserve pays roundPrice 1 RNG (heartbeat)
  V->>B: Act { commit r } from the rest of the set
  Note over B: commits close when all are in or after 5 s.<br/>A missing commit: slash 1000. Fewer than 2: void, same number reopens
  V->>B: Act { reveals: [{ r, alpha }], commit: { r+1, c' } }
  B->>D: verify-reveal (c, alpha, h)
  D-->>B: valid, y = h^alpha
  alt every output in
    Note over B: value = H(round | self | r | y... by address)
    B-->>P: RNG-Result (processes only, wallets read beaconround-<r%8>)
  else output missing at reveal deadline (30 s)
    Note over B: withholder slashed 1000, suspended, cooldown
    C->>B: Crack { r, validator, y, proof } (T = 2^27 squarings)
    B->>D: verify-crack (Wesolowski)
    Note over B: bounty 10 RNG from treasury to cracker,<br/>repaid from the withholder's bond, then finalize
  else no crack and abandonable
    Note over B: after abandonAfterMs (30 min), or 7 d cap:<br/>abandon, refund each request at its paid price
    B-->>P: RNG-Error Round-Abandoned
  end
```

A round with every commit in is not abandoned while the treasury can pay a
bounty, until the 7-day cap (`abandonable()`), so a withholder cannot void a
value after seeing it.

## Fast tier request

```mermaid
sequenceDiagram
  autonumber
  participant P as Payer
  participant T as RNG token
  participant F as Fast tier
  participant M as Committee daemons (3)
  P->>T: Transfer to Fast, X-Request-Id (3 RNG)
  T->>F: Credit-Notice
  Note over F: binds to round+1 (round+2 if round+1 is locked)
  M->>F: Partial { round, signature } (first one locks the round)
  M->>M: read beaconpartials, combine 2 partials, verify off-chain
  M->>F: Round { round, group signature }
  M->>F: Round { same signature } from a second member
  Note over F: 2 identical signatures (verification = attestations):<br/>value = H(round message | signature)
  F-->>P: RNG-Result (processes only)
  Note over F: 1 RNG to each of the 2 signers, 1 to protocolAccrued
  opt unsigned 30 min after the oldest request
    Note over F: refund, RNG-Error Round-Abandoned.<br/>If the value was already knowable: wait 7 d after lock, skip the number
  end
```

No clock: a round exists only when a paid request waits for it.

## Fair-play session

```mermaid
sequenceDiagram
  autonumber
  participant G as Game
  participant Pl as Player browser key
  participant F as Fair play
  participant B as Any-Honest beacon
  G->>F: Fair.Open { Session, Player } (reserves 4 RNG from the game's balance)
  Pl->>F: Fair.Commit { Game, Session, Commit = H(commit | G | S | s) }
  Note over F: joins the open batch, at most one request outstanding
  F->>B: Request-Random { Tier any-honest, Request-Id fair-<b> }
  B-->>F: RNG-Result (value v_b, after the round finalizes)
  Note over F: v = H(beacon | v_b | G | S), revealBy = now + 60 s.<br/>Batch price split over its sessions, top-up Transfer to the beacon
  alt player reveals in time
    Pl->>F: Fair.Reveal { Secret = s }
    Note over F: final = H(final | v | s)
  else no reveal by revealBy
    G->>F: Fair.Expire (anyone)
    Note over F: final = H(forfeit | v): the worst outcome
  end
  F-->>G: Fair-Result (process games, wallets read fairsessions)
```

## Governance

```mermaid
flowchart TD
  S["Stake RNG in the DAO<br/>(unstake delay 14 d)"] --> PR["Propose: 25,000 RNG threshold,<br/>5,000 deposit (lost to a veto)"]
  PR --> VO["Vote 1 day: quorum 10 %,<br/>pass > 50 %, veto > 33.34 %"]
  VO -->|passed| EX["DAO sends one Gov.* message,<br/>X-Dao-Proposal, Effective-At"]
  EX --> CL{"Class at the target"}
  CL -->|harmless: prices, pause, resume| AP1["Applied on receipt"]
  CL -->|money or code| Q["Checked on a copy, stored in govPending.<br/>Effective-At >= receipt + 24 h<br/>(7 d for Set-Successor, Move-Reserve)"]
  Q --> H["Exit hatch open until Effective-At + 1 h:<br/>validators Exit-Now, payers Withdraw"]
  Q -->|Gov.Cancel by a later proposal| X["Dropped"]
  Q -->|"Gov.Apply Gov-Id (anyone, once due, within 14 d)"| RB{"Bounds and treasury cap again"}
  RB -->|ok| AP2["Applied"]
  RB -->|refused| RF["Stays pending, no longer holds the hatch"]
```

Code upgrades are the same path: `Gov.Approve-Code Code-Root Effective-At`, then
anyone sends `Gov.Upgrade` parts; the code installs only at or after
`Effective-At` (`protocol/vendor/gov.lua`).

## Money flows

```mermaid
flowchart LR
  G["Genesis: 1,000,000,000 RNG<br/>to RNG Labs DA9q…"] --> R["Beacon reserve 200 M<br/>(X-Foundation)"]
  G --> TR["Beacon treasury 50 M<br/>(X-Treasury)"]
  G --> ST["DAO stake 50 M"]
  G --> BD["Validator bonds<br/>3 x 100,000 (bond-for)"]
  G --> LQ["Labs liquid remainder<br/>(seeds the RNG/PUSD book)"]
  U["Payers"] -->|"Transfer: credit at today's price<br/>(pay at deposit)"| BAL["Balances in beacon, Fast, fair"]
  BAL -->|"request 4 RNG"| SPLIT{" "}
  SPLIT -->|1| TR
  SPLIT -->|3, split| VP["Round contributors<br/>(validators or crackers)"]
  BAL -->|"subscription 1 RNG / 1000 rounds"| TR
  R -->|"1 RNG per heartbeat round, split"| VP
  BD -->|"slash 1,000 per failed duty"| TR
  TR -->|"crack bounty 10, repaid from bond"| VP
  BAL -->|"Fast 3 RNG: 1 + 1 to signers"| SG["Fast signers"]
  BAL -->|"Fast: 1 RNG"| PA["Fast protocolAccrued<br/>(Gov.Claim-Protocol)"]
  TR -->|"Gov.Treasury-Spend / Fund-Reserve<br/>max 10 % per rolling 30 d"| OUT["Recipient / reserve"]
  R -->|"Gov.Move-Reserve (7 d floor)"| SUC["Successor beacon"]
  VP -->|Claim| W["Own wallet"]
  SG -->|Claim| W
```

Governance can never take a bond or a balance: `Gov.Remove-Validator` refunds the
whole bond, and `Withdraw` / `Fair.Withdraw` work at any time, paused or not.
