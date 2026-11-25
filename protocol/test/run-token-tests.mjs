// Runs the RNG token's Lua tests.
//   node protocol/test/run-token-tests.mjs             local, AOS wasm via @permaweb/ao-loader
//   node protocol/test/run-token-tests.mjs --live URL  a HyperBEAM node's ~lua@5.3a (Luerl)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AoLoader from '@permaweb/ao-loader';
import { orderPrelude, transcriptHook, evalTail } from './order-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const AOS_WASM = process.env.AOS_WASM
  || path.join(process.env.PARALITH_ROOT || 'C:/REPO/paralith-mono', 'backend/native/module/AOS.wasm');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// TEST_SIG_TYPE=ed25519-sha512: every fixture signature (wallet and scheduler)
// an Ed25519 one, as a node's Ed25519 scheduling key (HyperBEAM
// `scheduler-key-type`) signs its assignments and pushes.
const fixture = (src) => (process.env.TEST_SIG_TYPE
  ? src.replace(/"rsa-pss-sha(512|256)"/g, JSON.stringify(process.env.TEST_SIG_TYPE)) : src);
const addr = (s) => s.padEnd(43, '_');
const F = {
  owner: addr('owner'), sched: addr('scheduler'), user: addr('user'),
  stranger: addr('stranger'), process: addr('process'), recipient: addr('recipient'),
};
const luaString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const fixtures = `F = { ${Object.entries(F).map(([k, v]) => `${k} = ${luaString(v)}`).join(', ')} }`;
const bundle = [
  orderPrelude(),
  read('protocol/vendor/json.lua'),
  'local jsonx = (function()', read('protocol/vendor/jsonenc.lua'), 'end)()',
  'encode, jsonObject = jsonx.encode, jsonx.object',
  'json = require(".json")',
  'Owner = nil',
  read('protocol/token/rng-token.lua'),
  fixtures,
  transcriptHook(),
  fixture(read('protocol/test/token_test.lua')),
].join('\n');

let text;
const live = process.argv.indexOf('--live');
if (live !== -1) {
  const node = process.argv[live + 1] || 'https://public-hb.tylerw.ai';
  const res = await fetch(`${node}/~lua@5.3a/runTokenTests`, {
    method: 'POST', headers: { 'content-type': 'application/lua' }, body: bundle,
  });
  text = await res.text();
  if (res.status !== 200) { console.error(`${node}: HTTP ${res.status}\n${text.slice(0, 2000)}`); process.exit(1); }
} else {
  const handle = await AoLoader(fs.readFileSync(AOS_WASM), {
    format: 'wasm32-unknown-emscripten', computeLimit: process.env.RNG_PAIRS ? 9e15 : 9e12, memoryLimit: 512 * 1024 * 1024,
  });
  const pid = addr('token-tests');
  const result = await handle(null, {
    Id: 'eval-token-tests', Target: pid, Owner: pid, From: pid,
    Tags: [{ name: 'Action', value: 'Eval' }], Data: bundle + evalTail('runTokenTests'),
    'Block-Height': '1', Timestamp: '1700000000000', Module: 'aos', Cron: false,
  }, { Process: { Id: pid, Owner: pid, Tags: [] }, Module: { Id: 'aos', Tags: [] } });
  if (result.Error) throw new Error(result.Error);
  const out = result.Output?.data;
  text = typeof out === 'string' ? out : out?.output ?? JSON.stringify(out);
}
console.log(text);
const verdict = /(\d+) passed, (\d+) failed\s*$/.exec(text);
if (!verdict || verdict[2] !== '0') process.exit(1);
