// What one slot costs the any-honest beacon at a given number of addresses on
// its books, on a node's free ~lua@5.3a endpoint (protocol/test/slot_bench.lua).
// Free, unsigned. The state is a live beacon's published keys; --accounts adds
// N funded and N emptied addresses to it, so you can see whether a slot grows
// with use (it must not: anyhonest_test.lua runCostTests is the gate).
//
//   node protocol/test/bench-beacon.mjs --seed <beacon pid> [--seed-node URL]
//        [--node URL] [--accounts N] [--slots K] [--src path/to/anyhonest.lua]
//
// Use a quiet node (a local one: docker run ... hbnode:<build>): a busy one's
// noise is larger than the effect. The wall figure is (K slots - 1 slot) / (K - 1).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgradeSource } from '../../deploy/deploy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const seedPid = arg('--seed');
const seedNode = arg('--seed-node', 'https://rng-hb.tylerw.ai');
const node = arg('--node', 'http://127.0.0.1:10000');
const accounts = Number(arg('--accounts', '0'));
const slots = Number(arg('--slots', '41'));
const src = arg('--src');
if (!/^[\w-]{43}$/.test(seedPid || '') || !(slots > 1)) throw new Error('--seed <pid> [--accounts N] [--slots K > 1]');

const res = await fetch(`${seedNode}/${seedPid}~process@1.0/now`, { headers: { accept: 'application/json' } });
if (!res.ok) throw new Error(`seed ${seedPid}: HTTP ${res.status}`);
const live = await res.json();
const st = JSON.parse(live.timelockstate);
for (let i = 0; i < accounts; i++) {
  const funded = `bench-f-${i}`.padEnd(43, '_'), empty = `bench-e-${i}`.padEnd(43, '_');
  st.balances[funded] = 1; st.purses[funded] = [{ n: 1, price: 4, sub: 1 }];
  st.balances[empty] = 0; st.purses[empty] = [];
}
live.timelockstate = JSON.stringify(st);
const seed = Object.entries(live).filter(([k, v]) => k.startsWith('timelock') && typeof v === 'string');
const long = (s) => {
  let eq = '';
  while (s.includes(`]${eq}]`)) eq += '=';
  return `[${eq}[${s}]${eq}]`;
};
const seedLua = `Seed = {\n${seed.map(([k, v]) => `  [${JSON.stringify(k)}] = ${long(v)},`).join('\n')}\n}`;
const OWNER = 'OWNERoooooooooooooooooooooooooooooooooooooo';
const SCHED = 'SCHEDulerrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
let module = upgradeSource('beacon', OWNER, SCHED);
if (src) {
  // As the lua-patch@1.0 bundle holds it: the final full collect moved out (deploy.mjs patchSource).
  const lf = (s) => {
    const t = s.split('\r').join(''), c = 'collectgarbage("collect")', at = t.lastIndexOf(c);
    return t.slice(0, at) + t.slice(at + c.length);
  };
  const cur = lf(fs.readFileSync(path.join(HERE, '../beacon/anyhonest.lua'), 'utf8'));
  if (!module.includes(cur)) throw new Error('bundle does not contain protocol/beacon/anyhonest.lua');
  module = module.replace(cur, () => lf(fs.readFileSync(src, 'utf8')));
}
const bench = fs.readFileSync(path.join(HERE, 'slot_bench.lua'), 'utf8').replace(/\r\n/g, '\n');

async function run(count) {
  const body = [module, 'BenchNoCollect = true', seedLua, bench,
    `function slotbenchrun() return slotbench("b", ${count}) end`].join('\n');
  const t0 = performance.now();
  const r = await fetch(`${node}/~lua@5.3a/slotbenchrun`, {
    method: 'POST', headers: { 'content-type': 'application/lua' }, body,
  });
  const text = await r.text();
  if (!r.ok || !/mode \w +slots \d+/.test(text)) throw new Error(`${r.status} ${text.slice(0, 400)}`);
  return { ms: performance.now() - t0, text: text.match(/mode .*/)[0] };
}

const one = await run(1);
const many = await run(slots);
console.log(`beacon ${seedPid}: ${Object.keys(st.balances).length} addresses on the books (+${accounts} funded, +${accounts} empty)`);
console.log(many.text);
console.log(`wall ${((many.ms - one.ms) / (slots - 1)).toFixed(1)} ms/slot on ${node}`);
