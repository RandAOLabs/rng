# Whisper-Node (reference for v4)

Source of the archived RandAOLabs/Whisper-Node repo: a Go MVP where a small committee forms a libp2p GossipSub mesh, publishes per-round messages, lets late joiners catch up over `/whisper/catchup/1.0.0`, and discovers peers through an EVM `PeerRegistry` contract. It is kept as reference for the v4 whisper network (validators gossiping bundles off-chain before posting). It is not used by RNG today.

Not copied, on purpose: the committed test identity keys (`data_peer1/identity.key`, `data_peer2/identity.key`) and the built binaries (`app.exe`, `whisper-node.exe`). The repo had no `.env` or wallet files. Run with your own `IDENTITY_SEED` and testnet key.

## Original README


Mini round-based P2P messaging MVP in Go.

This repo simulates a small “committee” of nodes that:

- form a libp2p mesh using **GossipSub**
- publish a **round message** (e.g. `round = 1`)
- store messages in a local **round cache**
- allow **late joiners** to catch up via a custom `/whisper/catchup/1.0.0` stream
- optionally use an **EVM smart contract** as a registry for peer discovery

It is **not** the full Whisper protocol — it’s a networking + determinism + test harness milestone.

---

## High-Level Architecture

- **`app/`** – main node binary (libp2p host + chain client + round logic)
- **`internal/chain/`** – Go client for the `PeerRegistry` Solidity contract
- **`internal/config/`** – configuration loader (env-driven)
- **`pkg/peerregistry/`** – Go bindings (via `abigen`) for the `PeerRegistry` contract
- **`docker-compose.yml`** – optional local multi-peer setup (earlier local-only version)

On startup a node:

1. Loads config from environment.
2. Builds a **deterministic or persisted identity** (stable libp2p PeerID).
3. Starts a libp2p host and subscribes to a **GossipSub** topic (default: `whisper/round/messages`).
4. Registers itself in the **`PeerRegistry`** contract and marks itself active.
5. Fetches **active peers** from the contract and dials them using their registered multiaddrs.
6. Publishes its own round message and listens for others.
7. Uses a **RoundCache** + **catchup RPC** so late nodes can request the full set of messages for a given round.

---

## Peer Registry Contract

The EVM contract (Solidity) tracks:

- registered peers:
  - `nodeName`
  - `multiaddr` (string; e.g. `/ip4/…/tcp/…/p2p/<peerID>`)
  - `lastSeen`
  - `active`
- rounds:
  - `id`, `creator`
  - `participants[]`
  - `createdAt`, `active`, `result`

Basic functions:

- `registerPeer(string nodeName, string multiaddr)`
- `setActive(bool active)`
- `getPeer(address peer)`
- `getAllPeers()`
- `getActivePeers()`  
- `createRoundFromActivePeers(uint256 maxParticipants)`
- `submitRoundResult(uint256 roundId, bytes32 result)`
- `getRound(uint256 roundId)`

In this MVP, the node mainly uses the **peer side** for discovery; rounds are still mostly local labels (`ROUND_ID`) used for indexing and logging.

---

## Prerequisites

- **Go** ≥ 1.20+
- **Node & EVM testnet access** (e.g. Sepolia via Infura/Alchemy)
- A deployed instance of the **`PeerRegistry`** contract (via Remix or Foundry)
- (Optional) **Docker** & **docker-compose** if you want to resurrect the original local 3–5 peer setup

---

## Running a Node (single process)

From the repo root:

1. Export chain + registry config:

```bash
export CHAIN_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/<YOUR_KEY>"
export CHAIN_ID="11155111"
export CHAIN_PRIVATE_KEY_HEX="0x<YOUR_TESTNET_PRIVATE_KEY>"
export PEER_REGISTRY_ADDRESS="0x<DEPLOYED_PEER_REGISTRY_ADDRESS>"
