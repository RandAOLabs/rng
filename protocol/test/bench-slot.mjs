// What one slot costs the fast tier or fair play at a live process's state, on
// a live node's free ~lua@5.3a endpoint (protocol/test/slot_bench.lua). Free,
// unsigned; the seed is a plain GET of the live process's published keys.
//
//   node protocol/test/bench-slot.mjs --role fast|fair --seed <pid> [--seed-node URL]
//        [--node URL] [--mode b|a] [--slots K]
//
// --mode b (default) is the lua-patch@1.0 spawn bundle, --mode a the lua@5.3a
// one. The wall figure (1 slot against K, difference / (K - 1)) is the one to
// trust; Luerl's os.clock is the whole node's CPU.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocolSources, patchSources } from '../../deploy/deploy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const role = arg('--role');
const seedPid = arg('--seed');
const seedNode = arg('--seed-node', 'https://rng-hb.tylerw.ai');
const node = arg('--node', 'https://public-hb.tylerw.ai');
const mode = arg('--mode', 'b');
const slots = Number(arg('--slots', '10'));
const PREFIX = { fast: 'beacon', fair: 'fair' }[role];
if (!PREFIX || !/^[\w-]{43}$/.test(seedPid || '') || !['a', 'b'].includes(mode) || !(slots > 1)) {
  throw new Error('--role fast|fair --seed <pid> [--mode a|b] [--slots K > 1]');
}

const res = await fetch(`${seedNode}/${seedPid}~process@1.0/now`, { headers: { accept: 'application/json' } });
if (!res.ok) throw new Error(`seed ${seedPid}: HTTP ${res.status}`);
const live = await res.json();
const seed = Object.entries(live).filter(([k, v]) => k.startsWith(PREFIX) && typeof v === 'string');
const long = (s) => {
  let eq = '';
  while (s.includes(`]${eq}]`)) eq += '=';
  return `[${eq}[${s}]${eq}]`;
};
const seedLua = `Seed = {\n${seed.map(([k, v]) => `  [${JSON.stringify(k)}] = ${long(v)},`).join('\n')}\n}`;
const OWNER = 'OWNERoooooooooooooooooooooooooooooooooooooo';
const SCHED = 'SCHEDulerrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const module = mode === 'b' ? patchSources[role](OWNER, SCHED) : protocolSources[role]();
const bench = fs.readFileSync(path.join(HERE, 'slot_bench.lua'), 'utf8').replace(/\r\n/g, '\n');

async function run(count) {
  const body = [module, ...(process.argv.includes('--no-collect') ? ['BenchNoCollect = true'] : []), seedLua, bench,
    `function slotbenchrun() return slotbench("${mode}", ${count}) end`].join('\n');
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
console.log(`${role} seeded from ${seedPid} (${seed.length} keys, ${seed.reduce((s, [, v]) => s + v.length, 0)} bytes)`);
console.log(many.text);
console.log(`wall ${((many.ms - one.ms) / (slots - 1)).toFixed(1)} ms/slot`
  + ` (${many.ms.toFixed(0)} ms for ${slots}, ${one.ms.toFixed(0)} ms for 1) on ${node}`);
