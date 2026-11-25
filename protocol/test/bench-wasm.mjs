// What one slot costs the fast tier or fair play on wasm-patch@1.0, at a
// given state size: the spawn bundle (deploy.mjs) on the wasm-lua runtime in
// Node (paralith-mono backend/native/wasm-lua/host.mjs, the runtime
// deploy/wasm-runtime.json pins). Node's WebAssembly tier-up is close to the
// node's AOT, so the figures are per-slot guest time, not node time.
//
//   PARALITH_MONO=<checkout> node protocol/test/bench-wasm.mjs [--role fast|fair] [--sizes 0,1000,6000,20000] [--slots 200]
//
// fast: the state is seeded through its published `beaconstate` (as a
// restart restores it) with N request ids live for the guard window; each
// timed slot is a stranger's Get-Info, which runs the whole per-message path
// (rollback copy, publish).
// fair: seeded through `fairstate` with N open sessions over N/16 games, a
// full history (1024) and credit window (1024) and N pruned (`done`) keys;
// each timed slot is a funded game's Fair.Open (a state change: rollback copy
// and publish), so the figure is what one more message costs at that size.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchSources, rngRuntime } from '../../deploy/deploy.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const PM = path.resolve(process.env.PARALITH_MONO || 'C:/REPO/paralith-mono');
const { WasmLua } = await import(pathToFileURL(path.join(PM, 'backend/native/wasm-lua/host.mjs')).href);
const runtime = rngRuntime({ pm: PM });
const ROLE = arg('--role', 'fast');
const SLOTS = Number(arg('--slots', 200));
const SIZES = arg('--sizes', arg('--seen', '0,1000,6000,20000')).split(',').map(Number);
const OWNER = 'OWNERoooooooooooooooooooooooooooooooooooooo';
const SCHED = 'SCHEDulerrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const SELF = 'SELFprocesspppppppppppppppppppppppppppppppp';
const STRANGER = 'STRANGERsssssssssssssssssssssssssssssssssss';
const GAME = 'GAMEgggggggggggggggggggggggggggggggggggggggg'.slice(0, 43);
const TOKEN = 'TOKENttttttttttttttttttttttttttttttttttttttt'.slice(0, 43);
const BEACON = 'BEACONbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'.slice(0, 43);
const PLAYER = 'PLAYERppppppppppppppppppppppppppppppppppppp'.slice(0, 43);
// PROFILE_WASM: paralith-mono's profiling build (WP_PROFILE=1 build.sh): per-function times after each size.
const module = await WebAssembly.compile(process.env.PROFILE_WASM
  ? (await import('node:fs')).readFileSync(process.env.PROFILE_WASM) : runtime.bytes);
const T0 = 1_800_000_000_000;

const signed = (signer, action, extra = {}) => ({ target: SELF, action, ...extra,
  commitments: { s: { committer: signer, alg: 'rsa-pss-sha512', committed: ['target', 'action'] } } });

const fastSeed = (n) => `Lua53bPublishedState = Lua53bPublishedState or {}
do
  local seen, queue = {}, {}
  for i = 1, ${n} do
    local k = string.format("REQUESTER%034d|req-%d", i, i)
    seen[k] = i
    queue[#queue + 1] = { k, ${T0} + 600000 + i }
  end
  local state = { rev = 1, self = "${SELF}", round = ${n}, seen = seen, seenQueue = queue }
  Lua53bPublishedState.beaconstate = encode(state)
  Lua53bPublishedState.beaconrev = "5"
end`;

const fairSeed = (n) => `Lua53bPublishedState = Lua53bPublishedState or {}
do
  local function addr(prefix, i) return (prefix .. string.format("%d", i) .. string.rep("_", 43)):sub(1, 43) end
  local sessions, games, accounts, done, history, credited = {}, {}, {}, {}, {}, {}
  local open = 0
  local o = { batch = 1, keys = {}, status = "open" }
  for i = 1, ${n} do
    local game = addr("G", i % math.max(1, ${n} // ${Number(process.env.PER_GAME || 16)}))
    local k = game .. "|s" .. i .. "|" .. addr("P", i)
    sessions[k] = { game = game, session = "s" .. i, player = addr("P", i), commit = string.rep("a", 64),
      status = "committed", batch = 1, windowMs = 60000, committedAt = ${T0}, reserve = 0 }
    o.keys[#o.keys + 1] = k
    open = open + 1
    games[game] = games[game] or { live = 0, allow = {}, held = {} }
    games[game].live = games[game].live + 1
    accounts[game] = { balance = 0, reserved = 0, nonce = 0 }
    if i <= ${process.env.DONE ?? n} then done[addr("D", i) .. "|x|" .. addr("Q", i)] = ${T0} + 600000 end
  end
  games["${GAME}"] = { live = 0, allow = {}, held = {} }
  accounts["${GAME}"] = { balance = 1000000000000000, reserved = 0, nonce = 0 }
  for i = 1, 1024 do history[i] = { "session:x|" .. i, i } end
  for i = 1, 1024 do credited[tostring(i)] = true end
  local gameCount = 0
  for _ in pairs(games) do gameCount = gameCount + 1 end
  local state = { beacon = "${BEACON}", windowMs = 60000, keep = 32, maxOpen = 100000, minIntervalMs = 600000,
    maxGames = 100000, maxPerGame = 4096, token = "${TOKEN}", price = 4000000, unit = 1000000,
    sessions = jsonObject(sessions), byGame = jsonObject({}), done = jsonObject(done), open = open, next = 1,
    batches = jsonObject({ ["1"] = o }), bound = {}, attempts = 0, retryAt = 0, games = jsonObject(games),
    gameCount = gameCount, lastRequestAt = ${T0} + 10000000, accounts = jsonObject(accounts),
    credited = jsonObject(credited), creditFloor = 0, transferSeq = 0, surplus = 0, changes = 1, history = history }
  Lua53bPublishedState.fairstate = encode({ rev = 5, owner = "${OWNER}", owners = { dao = "", wallet = true,
    approved = "", approvedAt = 0, code = { sha = "", version = 0 } }, gov = { pending = jsonObject({}), nextId = 1 },
    state = state })
  Lua53bPublishedState.fairrev = "5"
end`;

for (const n of SIZES) {
  const rt = new WasmLua(module);
  let lua = ROLE === 'fast' ? patchSources.fast(OWNER, SCHED) + '\n' + fastSeed(n)
    : patchSources.fair(OWNER, SCHED) + '\n' + fairSeed(n);
  // GC_STEP: the 5.3b adapter's collector step per message (deploy.mjs: 5000).
  if (process.env.GC_STEP) lua = lua.replace('Lua53bGcStep = 5000', `Lua53bGcStep = ${process.env.GC_STEP}`);
  const init = rt.init({ id: SELF, module: lua });
  if (init.status !== 0) throw new Error(`init: ${JSON.stringify(init.value)}`);
  let slot = 0;
  const call = () => {
    slot += 1;
    const b = ROLE === 'fast' ? signed(STRANGER, 'Get-Info')
      : signed(GAME, 'Fair.Open', { session: `bench-${slot}`, player: PLAYER });
    const res = rt.handle({ slot, timestamp: T0 + slot, process: SELF, body: b });
    if (res.status !== 0) throw new Error(`slot ${slot}: ${JSON.stringify(res.error ?? res)}`);
    return res;
  };
  for (let i = 0; i < 20; i++) call(); // restore and warm up
  const reply = JSON.stringify(call().results?.output?.data ?? '').slice(0, 120);
  if (process.env.PROFILE_WASM) rt.profileReset();
  const t = performance.now();
  let bytes = 0;
  for (let i = 0; i < SLOTS; i++) {
    const res = call();
    for (const p of res.patches || []) bytes += p.value?.length ?? 0;
  }
  const ms = (performance.now() - t) / SLOTS;
  if (process.env.PROFILE_WASM) console.log(rt.profileText());
  console.log(`${ROLE}  size ${String(n).padStart(6)}  ${ms.toFixed(2)} ms/slot  ${(bytes / SLOTS / 1024).toFixed(1)} KiB published/slot  reply ${reply}`);
}
