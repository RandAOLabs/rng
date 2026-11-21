// What one Transfer slot costs the RNG token at N holders, on a live node's
// free ~lua@5.3a endpoint (protocol/test/token_bench.lua). Free, unsigned.
//
//   node protocol/test/bench-token.mjs [--node URL] [--holders N] [--transfers K]
//        [--mode b|a] [--token <rng-token.lua>]
//
// --mode b (default) is the lua-patch@1.0 spawn bundle (deploy.mjs
// tokenPatchSource); --mode a the bare token as lua@5.3a runs it. --token
// benches another copy of the contract (e.g. `git show <rev>:protocol/token/
// rng-token.lua` for a before figure).
//
// Luerl's os.clock is the whole node's CPU, so it reads high on a busy node.
// The wall figure is the one to trust: the same request with 1 and with K
// Transfers, the difference divided by K - 1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchSource } from '../../deploy/deploy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const node = arg('--node', 'https://public-hb.tylerw.ai');
const holders = Number(arg('--holders', '10000'));
const transfers = Number(arg('--transfers', '20'));
const mode = arg('--mode', 'b');
if (!['a', 'b'].includes(mode) || !(transfers > 1)) throw new Error('--mode a|b, --transfers > 1');
const read = (p) => fs.readFileSync(path.resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const tokenLua = read(arg('--token', 'protocol/token/rng-token.lua'));
const contract = [
  read('protocol/vendor/json.lua'),
  'local jsonx = (function()', read('protocol/vendor/jsonenc.lua'), 'end)()',
  'local encode, jsonObject = jsonx.encode, jsonx.object',
  tokenLua,
].join('\n');
const OWNER = 'OWNERoooooooooooooooooooooooooooooooooooooo';
const SCHED = 'SCHEDulerrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const module = mode === 'b'
  ? patchSource(contract, { owner: OWNER, scheduler: SCHED, keepalive: 'ticker', name: 'token' })
  : contract;
const bench = read('protocol/test/token_bench.lua');

async function run(count) {
  const body = [module, ...(process.argv.includes('--no-collect') ? ['BenchNoCollect = true'] : []), bench,
    `function tokenbenchrun() return tokenbench("${mode}", ${holders}, ${count}) end`].join('\n');
  const t0 = performance.now();
  const res = await fetch(`${node}/~lua@5.3a/tokenbenchrun`, {
    method: 'POST', headers: { 'content-type': 'application/lua' }, body,
  });
  const text = await res.text();
  if (!res.ok || !/mode \w +holders \d+/.test(text)) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  return { ms: performance.now() - t0, text: text.match(/mode .*/)[0] };
}

const one = await run(1);
const many = await run(transfers);
console.log(many.text);
console.log(`wall ${((many.ms - one.ms) / (transfers - 1)).toFixed(1)} ms/transfer`
  + ` (${many.ms.toFixed(0)} ms for ${transfers}, ${one.ms.toFixed(0)} ms for 1) on ${node}`);
