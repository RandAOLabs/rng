// Deploy and drive the RandAO v2 test network.
//
//   node deploy/deploy.mjs spawn                     spawn TEST-RNG and the beacon
//   node deploy/deploy.mjs spawn-beacon              replace only the beacon (keeps the token)
//   node deploy/deploy.mjs spawn-token               replace only the token (then reconfigure the beacons)
//   node deploy/deploy.mjs configure <committee.json> set token, committee, group key
//   node deploy/deploy.mjs fund <rng> [for]           faucet, then fund a beacon balance
//   node deploy/deploy.mjs request [id]               ask for one beacon value
//   node deploy/deploy.mjs info                       print the beacon's published info
//   node deploy/deploy.mjs spawn-timelock             spawn the time-lock beacon (uses the token)
//   node deploy/deploy.mjs configure-timelock <params.json>  token, unit and SPEC 2.1 parameters
//   node deploy/deploy.mjs add-validator <address> | remove-validator <address>
//
// Env: HB_NODE (default https://hb.randao.net), HB_WALLET (path to the
// owner/deployer wallet JWK), DEPLOY_STATE (default deploy/testnet.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, jwkToAddress, awaitComputedSlot, pendingPushes } from '../vendor/hbclient.mjs';
import { spawnLua, message } from '../provider/hb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V2 = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(path.join(V2, p), 'utf8');
const NODE = process.env.HB_NODE || 'https://hb.randao.net';
const WALLET = process.env.HB_WALLET;
if (!WALLET) throw new Error('set HB_WALLET to the deployer wallet JWK path');
// DEPLOY_STATE picks another network's record (e.g. the soak network).
const STATE = process.env.DEPLOY_STATE ? path.resolve(process.env.DEPLOY_STATE) : path.join(HERE, 'testnet.json');
const jwk = JSON.parse(fs.readFileSync(WALLET, 'utf8'));
const me = jwkToAddress(jwk);
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

const json = () => [
  read('vendor/json.lua'),
  'local jsonx = (function()', read('vendor/jsonenc.lua'), 'end)()',
  'local encode, jsonObject = jsonx.encode, jsonx.object',
];
const tokenSource = () => [...json(), read('token/rng-token.lua')].join('\n');
const timelockSource = () => [...json(), 'rng = (function()', read('lib/rng.lua'), 'end)()', read('beacon/timelock.lua')].join('\n');
const beaconSource = () => [...json(), 'rng = (function()', read('lib/rng.lua'), 'end)()', read('beacon/beacon.lua')].join('\n');

async function send(pid, action, { tags = {}, data } = {}) {
  const slot = await message({ node: NODE, jwk, process: pid, action, tags, data });
  await awaitComputedSlot({ node: NODE, process: pid, slot });
  const out = await readState({ node: NODE, process: pid, path: `compute&slot=${slot}/results/output/data` });
  await pendingPushes({ node: NODE, process: pid });
  return { slot, output: out.value };
}

async function beaconInfo() {
  const r = await readState({ node: NODE, process: state.beacon, path: 'now/beaconinfo' });
  return JSON.parse(r.value);
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'spawn') {
  if (state.beacon) throw new Error(`already deployed (${STATE}); move it aside to redeploy`);
  state.node = NODE;
  state.owner = me;
  state.token = await spawnLua({ node: NODE, jwk, lua: tokenSource(), tags: { name: 'TEST-RNG' } });
  console.log('token ', state.token);
  save();
  state.beacon = await spawnLua({ node: NODE, jwk, lua: beaconSource(), tags: { name: 'RNG-Beacon' } });
  console.log('beacon', state.beacon);
  save();
  // First messages initialise each process and publish its read keys.
  console.log('token info ', (await send(state.token, 'Info')).output);
  console.log('beacon info', (await send(state.beacon, 'Get-Info')).output);
}

if (cmd === 'spawn-token') {
  if (state.token) (state.retiredTokens ||= []).push(state.token);
  state.token = await spawnLua({ node: NODE, jwk, lua: tokenSource(), tags: { name: 'TEST-RNG' } });
  console.log('token', state.token);
  save();
  console.log('token info', (await send(state.token, 'Info')).output);
}

if (cmd === 'spawn-beacon') {
  if (state.beacon) (state.retired ||= []).push(state.beacon);
  state.beacon = await spawnLua({ node: NODE, jwk, lua: beaconSource(), tags: { name: 'RNG-Beacon' } });
  console.log('beacon', state.beacon);
  save();
  console.log('beacon info', (await send(state.beacon, 'Get-Info')).output);
}

if (cmd === 'configure') {
  const committee = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  state.groupKey = committee.groupKey;
  state.committee = committee.members;
  save();
  const r = await send(state.beacon, 'Configure', { data: JSON.stringify({
    self: state.beacon, token: state.token, unit: 1000000, threshold: committee.t, cadenceMs: 5000,
    groupKey: committee.groupKey, committee: committee.members, useDevice: committee.useDevice,
  }) });
  console.log(r.output);
}

if (cmd === 'fund') {
  const rng = Number(args[0] || 10);
  const forWho = args[1] || me;
  console.log('faucet', (await send(state.token, 'Faucet')).output);
  console.log('transfer', (await send(state.token, 'Transfer', {
    tags: { Recipient: state.beacon, Quantity: String(rng * 1000000), 'X-For': forWho },
  })).output);
  console.log('balance', (await send(state.beacon, 'Balance', { tags: { Account: forWho } })).output);
}

if (cmd === 'request') {
  const id = args[0] || `req-${Date.now()}`;
  console.log('request', (await send(state.beacon, 'Request-Random', { tags: { Tier: 'beacon', 'Request-Id': id } })).output);
  const target = (await beaconInfo()).nextRound;
  for (let i = 0; i < 60; i++) {
    const info = await beaconInfo();
    if (info.round >= target) {
      const round = await send(state.beacon, 'Get-Info');
      console.log(`round ${info.round} finalized after ~${i}s`, round.output);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

if (cmd === 'info') console.log(JSON.stringify(await beaconInfo(), null, 1));

if (cmd === 'spawn-timelock') {
  if (state.timelock) (state.retiredTimelock ||= []).push(state.timelock);
  state.timelock = await spawnLua({ node: NODE, jwk, lua: timelockSource(), tags: { name: 'RNG-Timelock-Beacon' } });
  console.log('timelock', state.timelock);
  save();
}

if (cmd === 'configure-timelock') {
  const params = args[0] ? JSON.parse(fs.readFileSync(args[0], 'utf8')) : {};
  console.log((await send(state.timelock, 'Configure', { data: JSON.stringify({ self: state.timelock, token: state.token, unit: 1000000, ...params }) })).output);
}

if (cmd === 'add-validator' || cmd === 'remove-validator') {
  const action = cmd === 'add-validator' ? 'Admin.Add-Validator' : 'Admin.Remove-Validator';
  console.log((await send(state.timelock, action, { data: JSON.stringify({ address: args[0] }) })).output);
  const r = await readState({ node: NODE, process: state.timelock, path: 'now/beaconinfo' });
  console.log('validators:', JSON.parse(r.value).validators.map((v) => v.address).join(', '));
}
