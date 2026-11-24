// What one slot costs the fast tier, fair or the token on wasm-patch@1.0, at
// a given state size: the spawn bundle (deploy.mjs) on the wasm-lua runtime
// in Node (paralith-mono backend/native/wasm-lua/host.mjs, the runtime
// deploy/wasm-runtime.json pins). Node's WebAssembly tier-up is close to the
// node's AOT, so the figures are per-slot guest time, not node time.
//
//   PARALITH_MONO=<checkout> node protocol/test/bench-wasm.mjs [--role fast] [--seen 0,1000,6000,20000] [--slots 200]
//
// The fast tier's state is seeded through its published `beaconstate` (as a
// restart restores it) with `seen` entries live for the guard window, then
// each timed slot is a stranger's Get-Info, which still runs the whole
// per-message path (rollback copy, publish).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchSources, rngRuntime } from '../../deploy/deploy.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const PM = path.resolve(process.env.PARALITH_MONO || 'C:/REPO/paralith-mono');
const { WasmLua } = await import(pathToFileURL(path.join(PM, 'backend/native/wasm-lua/host.mjs')).href);
const runtime = rngRuntime({ pm: PM });
const SLOTS = Number(arg('--slots', 200));
const SEEN = arg('--seen', '0,1000,6000,20000').split(',').map(Number);
const OWNER = 'OWNERoooooooooooooooooooooooooooooooooooooo';
const SCHED = 'SCHEDulerrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const SELF = 'SELFprocesspppppppppppppppppppppppppppppppp';
const STRANGER = 'STRANGERsssssssssssssssssssssssssssssssssss';
const module = await WebAssembly.compile(runtime.bytes);
const T0 = 1_800_000_000_000;

function body(action, slot, extra = {}) {
  return { target: SELF, action, ...extra,
    commitments: { s: { committer: STRANGER, alg: 'rsa-pss-sha512', committed: ['target', 'action'] } } };
}

for (const n of SEEN) {
  const rt = new WasmLua(module);
  const seed = `Lua53bPublishedState = Lua53bPublishedState or {}
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
  const lua = patchSources.fast(OWNER, SCHED) + '\n' + seed;
  const init = rt.init({ id: SELF, module: lua });
  if (init.status !== 0) throw new Error(`init: ${JSON.stringify(init.value)}`);
  let slot = 0;
  const call = () => {
    slot += 1;
    const res = rt.handle({ slot, timestamp: T0 + slot, process: SELF, body: body('Get-Info', slot) });
    if (res.status !== 0) throw new Error(`slot ${slot}: ${JSON.stringify(res.error ?? res)}`);
    return res;
  };
  for (let i = 0; i < 20; i++) call(); // restore and warm up
  const t = performance.now();
  let bytes = 0;
  for (let i = 0; i < SLOTS; i++) {
    const res = call();
    for (const p of res.patches || []) bytes += p.value?.length ?? 0;
  }
  const ms = (performance.now() - t) / SLOTS;
  console.log(`fast  seen ${String(n).padStart(6)}  ${ms.toFixed(2)} ms/slot  ${(bytes / SLOTS / 1024).toFixed(1)} KiB published/slot`);
}
