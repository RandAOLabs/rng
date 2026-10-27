// Time-lock beacon contract tests: real puzzles from provider/timelock.mjs,
// the contract run in Lua through compute(), timelock@1.0 mocked by a table
// of the (input -> valid) answers the reference gives.
//   node test/run-timelock-tests.mjs            local (AOS wasm)
//   node test/run-timelock-tests.mjs --live URL a node's ~lua@5.3a (Luerl)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AoLoader from '@permaweb/ao-loader';
import * as tl from '../provider/timelock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V2 = path.resolve(HERE, '..');
const AOS_WASM = process.env.AOS_WASM
  || path.join(process.env.PARALITH_ROOT || '../paralith-mono', 'backend/native/module/AOS.wasm');
const read = (p) => fs.readFileSync(path.join(V2, p), 'utf8');
const sha = (s) => createHash('sha256').update(s, 'latin1').digest('hex');
const addr = (s) => s.padEnd(43, '_');

const T = 1024, BITS = 1024;
const F = {
  owner: addr('owner'), sched: addr('scheduler'), stranger: addr('stranger'), token: addr('rng-token'),
  game: addr('game'), beacon: addr('timelock-beacon'), unit: 1000000, T, bits: BITS,
  v: [addr('val-a'), addr('val-b'), addr('val-c')],
};
F.ok = {}; // device answers the mock accepts
const puzzles = {};
const bad = (h) => (BigInt('0x' + h) + 1n).toString(16);
function puzzle(round, i) {
  const m = tl.newModulus(BITS);
  const seed = tl.seedFor(F.beacon, round, F.v[i]);
  const y = tl.solveWithTrapdoor(m, seed, T);
  F.ok[`verify-reveal|${m.N}|${seed}|${y}|${m.p}`] = true;
  puzzles[`${round}|${i}`] = { N: m.N, y, p: m.p, seed };
  return { N: m.N, y, p: m.p, badp: bad(m.p) };
}
const P = {};
for (const [r, idx] of [[1, [0, 1, 2]], [2, [0, 1, 2]], [3, [0, 1]], [4, [0, 1]], [5, [0]]]) {
  for (const i of idx) P[`r${r}v${i}`] = puzzle(r, i);
}
// Round 2: validator c withholds; a cracks it.
const c2 = puzzles['2|2'];
const cracked = tl.crack(c2.N, c2.seed, T);
F.ok[`verify-crack|${c2.N}|${c2.seed}|${cracked.y}|${cracked.proof}`] = true;
F.crack2 = cracked;
const value = (r, idx) => tl.roundValue(F.beacon, r, Object.fromEntries(idx.map((i) => [F.v[i], puzzles[`${r}|${i}`].y])));
F.value1 = value(1, [0, 1, 2]);
F.value2 = tl.roundValue(F.beacon, 2, { [F.v[0]]: puzzles['2|0'].y, [F.v[1]]: puzzles['2|1'].y, [F.v[2]]: cracked.y });
F.out1 = sha(`${F.value1}|req-1`);
F.config = JSON.stringify({ self: F.beacon, token: F.token, unit: F.unit, T, modulusBits: BITS,
  commitWindowMs: 3000, revealWindowMs: 10000, minCommits: 2, cadenceMs: 0, suspendAfter: 3 });

const luaString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const lua = (v) => Array.isArray(v) ? `{ ${v.map(lua).join(', ')} }`
  : typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `[${luaString(k)}] = ${lua(x)}`).join(', ')} }`
  : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? String(v) : luaString(v);
const fixtures = `F = ${lua(F)}\nP = ${lua(P)}`;

const bundle = [
  read('vendor/json.lua'),
  'local jsonx = (function()', read('vendor/jsonenc.lua'), 'end)()',
  'encode, jsonObject = jsonx.encode, jsonx.object',
  'json = require(".json")',
  'Owner = nil',
  'rng = (function()', read('lib/rng.lua'), 'end)()',
  read('beacon/timelock.lua'),
  fixtures,
  read('test/timelock_test.lua'),
].join('\n');

function verdict(text) {
  console.log(text);
  const m = /(\d+) passed, (\d+) failed\s*$/.exec(text);
  if (!m) { console.error('no verdict'); process.exit(1); }
  process.exit(m[2] === '0' ? 0 : 1);
}

const live = process.argv.indexOf('--live');
if (live !== -1) {
  const node = process.argv[live + 1] || 'https://hb.randao.net';
  const res = await fetch(`${node}/~lua@5.3a/rngtest`, { method: 'POST', headers: { 'content-type': 'application/lua' }, body: bundle });
  const body = await res.text();
  if (res.status !== 200) { console.error(`${node}: HTTP ${res.status}\n${body.slice(0, 3000)}`); process.exit(1); }
  verdict(body);
} else {
  const handle = await AoLoader(fs.readFileSync(AOS_WASM), { format: 'wasm32-unknown-emscripten', computeLimit: 9e12, memoryLimit: 512 * 1024 * 1024 });
  const pid = addr('timelock-tests');
  const result = await handle(null, {
    Id: 'eval-timelock-tests', Target: pid, Owner: pid, From: pid, Tags: [{ name: 'Action', value: 'Eval' }],
    Data: bundle + '\nreturn runTimelockTests()', 'Block-Height': '1', Timestamp: '1700000000000', Module: 'aos', Cron: false,
  }, { Process: { Id: pid, Owner: pid, Tags: [] }, Module: { Id: 'aos', Tags: [] } });
  if (result.Error) { console.error(result.Error); process.exit(1); }
  const out = result.Output?.data;
  verdict(typeof out === 'string' ? out : out?.output ?? JSON.stringify(out));
}
