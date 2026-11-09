import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadAllocations, genesisPrelude, badParams, genesisConfig, daoRules, sameScheduler,
  fillTemplate, proposalErrors, checkV3, SUPPLY_ATOMS, setDaoErrors, renounceErrors, fundError,
  effectiveAt, isMoneyProposal, LABS_STAKE_RNG, floorFor, RESERVE_FLOOR_MS, buildErrors, watchAlerts,
  fastGenesisConfig, PROTOCOL_ROLES, INFO_KEY, protocolSources, beaconRate, historyPoint, rateChecks, MIN_RATE,
  retireRole, addRateSample, rateBase,
} from '../deploy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const pid = (s) => s.padEnd(43, '_');
const DEPLOYER = pid('deployer');
const state = readJson('deploy/native-testnet.json');
const live = readJson('deploy/v3-mainnet.json');
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, 'site/deploy/native-testnet.env'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);

test('console deployment follows the live v3 processes', () => {
  assert.equal(env.RNG_TOKEN_ID, live.token);
  assert.equal(env.RNG_BEACON_ID, live.fast);
  assert.equal(env.RNG_ANYHONEST_ID, live.beacon);
  assert.equal(env.RNG_DAO_ID, live.dao);
});

test('deployment manifests retain state and load the pinned console environment', () => {
  const consoleCompose = fs.readFileSync(path.join(ROOT, 'site/deploy/compose.yaml'), 'utf8');
  const hyperbeamCompose = fs.readFileSync(path.join(ROOT, 'deploy/compose.hyperbeam-stage.yaml'), 'utf8');
  assert.match(consoleCompose, /native-testnet\.env/);
  assert.match(hyperbeamCompose, /store-overlay5:\/app\/cache-mainnet/);
  assert.match(hyperbeamCompose, /node-config\.json:\/app\/node-config\.json:ro/);
});

test('genesis: RNG Labs holds 100 % in one allocation; 250 M goes under DAO control by transfer', () => {
  const spec = readJson('deploy/v3-genesis.json');
  assert.equal(spec.allocations.length, 1, 'one allocation');
  assert.equal(spec.allocations[0].role, 'labs');
  const a = loadAllocations(spec, { deployer: DEPLOYER });
  assert.deepEqual(Object.keys(a.table), [DEPLOYER]);
  assert.equal(a.table[DEPLOYER], SUPPLY_ATOMS);
  assert.equal(a.rows.length, 1);
  assert.equal(a.reserveRng, 200_000_000);
  assert.equal(a.treasuryRng, 50_000_000);
  assert.equal(a.reserveRng + a.treasuryRng, 250_000_000, 'DAO control: reserve + treasury');
  assert.equal(a.validatorRng, 100_000);
  assert.equal(a.ticker, 'RNG', 'no TEST- prefix');
  const vals = readJson('deploy/anyhonest-validators.json').length;
  assert.ok(BigInt(a.reserveRng + a.treasuryRng + vals * a.validatorRng) * 1_000_000n <= SUPPLY_ATOMS);
  assert.throws(() => loadAllocations({ ...spec, distribution: { reserveRng: 0.5 } }, { deployer: DEPLOYER }), /whole/);
  assert.throws(() => loadAllocations({ ...spec, distribution: { reserveRng: 1_000_000_000, treasuryRng: 1 } },
    { deployer: DEPLOYER }), /exceeds/);
});

test('genesis allocations refuse a wrong sum, a bad address or a fraction', () => {
  const one = (rows) => ({ allocations: rows });
  assert.throws(() => loadAllocations(one([{ address: DEPLOYER, rng: 999_999_999 }])), /not exactly/);
  assert.throws(() => loadAllocations(one([{ address: DEPLOYER, rng: 1_000_000_001 }])), /not exactly/);
  assert.throws(() => loadAllocations(one([{ address: 'short', rng: 1_000_000_000 }])), /invalid address/);
  assert.throws(() => loadAllocations(one([{ address: DEPLOYER, rng: 0.5 }])), /whole/);
  assert.throws(() => loadAllocations(one([{ address: DEPLOYER, atoms: '1e15' }])), /positive integer/);
  assert.throws(() => loadAllocations(one([{ address: '$DEPLOYER', rng: 1_000_000_000 }])), /invalid address/);
  const split = loadAllocations(one([
    { address: pid('a'), atoms: '400000000000001' }, { address: pid('b'), atoms: '599999999999999' }]));
  assert.equal(split.table[pid('a')] + split.table[pid('b')], SUPPLY_ATOMS);
});

test('genesis prelude is Lua integers the token reads as GenesisAllocations', () => {
  const a = loadAllocations({ ticker: 'TEST-RNG', allocations: [
    { address: pid('b'), rng: 600_000_000 }, { address: pid('a'), rng: 400_000_000 }] });
  const prelude = genesisPrelude(a);
  assert.match(prelude, /^GenesisAllocations = \{\n/);
  assert.match(prelude, new RegExp(`\\["${pid('a')}"\\] = 400000000000000,`));
  assert.match(prelude, /TokenTicker = "TEST-RNG"$/);
  const sum = [...prelude.matchAll(/\] = (\d+),/g)].reduce((s, m) => s + BigInt(m[1]), 0n);
  assert.equal(sum, SUPPLY_ATOMS);
  assert.doesNotMatch(genesisPrelude({ ...a, ticker: 'RNG' }), /TokenTicker/);
});

test('genesis prelude evaluates in AOS Lua to integer atoms summing to 10^15', async (t) => {
  const wasm = process.env.AOS_WASM
    || path.join(process.env.PARALITH_ROOT || 'C:/REPO/paralith-mono', 'backend/native/module/AOS.wasm');
  if (!fs.existsSync(wasm)) return t.skip('AOS.wasm not available');
  const { default: AoLoader } = await import('@permaweb/ao-loader');
  const handle = await AoLoader(fs.readFileSync(wasm), { format: 'wasm32-unknown-emscripten', computeLimit: 9e12, memoryLimit: 256 * 1024 * 1024 });
  const prelude = genesisPrelude(loadAllocations(readJson('deploy/v3-genesis.json'), { deployer: DEPLOYER }));
  const id = pid('prelude');
  const r = await handle(null, {
    Id: 'eval-prelude', Target: id, Owner: id, From: id, Tags: [{ name: 'Action', value: 'Eval' }],
    Data: `${prelude}\nlocal s, n = 0, 0\nfor _, v in pairs(GenesisAllocations) do assert(math.type(v) == "integer"); s = s + v; n = n + 1 end\nreturn tostring(s) .. ":" .. n .. ":" .. tostring(TokenTicker)`,
    'Block-Height': '1', Timestamp: '1700000000000', Module: 'aos', Cron: false,
  }, { Process: { Id: id, Owner: id, Tags: [] }, Module: { Id: 'aos', Tags: [] } });
  const out = r.Output?.data;
  // No TokenTicker override: rng-token.lua's own default, RNG.
  assert.match(typeof out === 'string' ? out : out?.output ?? JSON.stringify(out), /1000000000000000:1:nil/);
});

test('v3 params template is inside the beacon hard bounds, and each bound bites', () => {
  const { predecessor, ...p } = readJson('deploy/v3-params.json');
  assert.equal(predecessor, '', 'a fresh deploy has no predecessor beacon');
  assert.deepEqual(badParams(p), []);
  for (const bad of [{ T: 2 ** 26 }, { revealWindowMs: 9999 }, { commitWindowMs: 10001 }, { abandonAfterMs: 1000 },
    { slash: 30000 }, { slash: 2501 }, { stake: 10 ** 7 + 1 }, { rejoinBaseMs: 1000 }, { rejoinCapMs: 31 * 86400000 },
    { minCommits: 1 }, { maxActive: 129 }, { maxActive: 7, minCommits: 2 }, { maxValidators: 63 }, { heartbeat: 2 }, { roundPrice: 0 },
    { subscriptionRounds: 0 }, { maxInFlight: 0 }, { fairWindowMs: 0 }, { stake: 1.5 }]) {
    assert.notDeepEqual(badParams({ ...p, ...bad }), [], JSON.stringify(bad));
  }
});

test('genesis Gov.Configure names token, unit, self, predecessor and h', () => {
  const hTable = readJson('deploy/anyhonest-h.json');
  const params = readJson('deploy/v3-params.json');
  const d = genesisConfig({ beacon: pid('beacon'), token: pid('token'), params, hTable });
  assert.equal(d.self, pid('beacon'));
  assert.equal(d.token, pid('token'));
  assert.equal(d.unit, 1_000_000);
  assert.equal(d.predecessor, '');
  assert.equal(d.h, hTable['134217728'].h);
  assert.equal(d.hProof, hTable['134217728'].hProof);
  assert.equal(d.roundPrice, 1);
  assert.equal(d.rejoinBond, undefined);
  assert.throws(() => genesisConfig({ beacon: pid('beacon'), token: pid('token'), params: { ...params, T: 2 ** 28 }, hTable }), /no h/);
  assert.throws(() => genesisConfig({ beacon: pid('beacon'), token: pid('token'), params: { ...params, commitWindowMs: 1 }, hTable }), /hard bounds/);
});

test('RNG DAO rules follow the spec', () => {
  const r = daoRules({ token: pid('token'), ticker: readJson('deploy/v3-genesis.json').ticker });
  assert.equal(r['Dao-Token'], pid('token'));
  assert.equal(r['Dao-Name'], 'RNG DAO', 'no TEST- prefix on the DAO');
  assert.equal(r['Dao-Ticker'], 'RNG');
  assert.equal(r['Proposal-Threshold'], String(25_000e6));
  assert.equal(r['Proposal-Deposit'], String(5_000e6));
  assert.equal(r['Voting-Period'], String(86400000), 'one day: the floor stake-dao/1 allows');
  assert.equal(r['Unstake-Delay'], String(14 * 86400000));
  assert.deepEqual([r['Quorum-Bps'], r['Pass-Bps'], r['Veto-Bps'], r['Max-Active-Proposals']], ['1000', '5000', '3334', '20']);
  assert.ok(Number(r['Max-Proposals-Per-Proposer']) <= Number(r['Max-Active-Proposals']));
  assert.equal(r['Dao-Admin'], undefined, 'stake-dao/1 refuses Dao-Admin');
  assert.equal(daoRules({ token: pid('token') })['Dao-Name'], 'RNG DAO');
});

test('token, DAO, beacon and fair must share one scheduler', () => {
  const S = pid('sched');
  const s = { scheduler: S, token: pid('t'), dao: pid('d'), beacon: pid('b'), processes: {
    [pid('t')]: { scheduler: S }, [pid('d')]: { scheduler: S }, [pid('b')]: { scheduler: S } } };
  assert.equal(sameScheduler(s, ['token', 'dao', 'beacon']), true);
  assert.throws(() => sameScheduler({ ...s, processes: { ...s.processes, [pid('d')]: { scheduler: pid('other') } } },
    ['token', 'dao', 'beacon']), /from-process would not be believed/);
  assert.throws(() => sameScheduler(s, ['fair']), /not deployed/);
  assert.throws(() => sameScheduler({ ...s, processes: {} }, ['token']), /no spawn record/);
  assert.throws(() => sameScheduler({ ...s, scheduler: undefined }, ['token']), /no scheduler/);
});

test('proposal templates are valid against the DAO caps, reserved names and beacon tags', () => {
  const dir = path.join(ROOT, 'deploy/proposals');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 8);
  const committee = readJson('deploy/committee.json');
  const vars = { BEACON: pid('beacon'), FAST: pid('fast'), DAO: pid('dao'), TOKEN: pid('token'), SUCCESSOR: pid('next'),
    RECIPIENT: pid('who'), VALIDATOR: pid('val'), QUANTITY: '1000000', FAIR: pid('fair'), TARGET: pid('beacon'),
    NEW_DAO: pid('dao2'), CODE_ROOT: 'a'.repeat(64), GOV_ID: '3', EFFECTIVE_AT: effectiveAt({ now: 1e12 }),
    COMMITTEE: JSON.stringify(committee.members.slice(0, 2)), SHARE_KEYS: JSON.stringify(committee.sharePublicKeys.slice(0, 2)),
    GROUP_KEY: committee.groupKey };
  assert.ok(!files.some((f) => /guardian/i.test(f)), 'no guardian template');
  for (const f of files) {
    const template = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const p = fillTemplate(template, { ...vars,
      EFFECTIVE_AT: effectiveAt({ now: 1e12, floorMs: floorFor(template.execTags.Action) }) });
    assert.deepEqual(proposalErrors(p, { token: vars.TOKEN, fast: vars.FAST, fair: vars.FAIR, now: 1e12 }), [], f);
    assert.doesNotMatch(JSON.stringify(p), /Gov\.Handover|on receipt, up to/i, `${f} describes the old design`);
    const target = p.execProcess === vars.FAST ? 'fast-tier' : p.execProcess === vars.FAIR ? 'fair' : 'beacon';
    assert.equal('Effective-At' in p.execTags, isMoneyProposal(p, target), `${f}: Effective-At exactly on money/code`);
    assert.doesNotMatch(JSON.stringify(p), /guardian/i, `${f} mentions a guardian`);
    assert.doesNotMatch(JSON.stringify(p), /\$[A-Z]/, `${f} has an unfilled placeholder`);
  }
  const ok = { title: 't', body: '', execProcess: pid('beacon'), execTags: { Action: 'Gov.Pause' } };
  assert.deepEqual(proposalErrors(ok), []);
  const bad = (execTags, extra = {}) => proposalErrors({ ...ok, ...extra, execTags }, { token: pid('token') });
  assert.match(bad({ Action: 'Gov.Pause', Data: 'x' }).join(), /reserved/);
  assert.match(bad({ Action: 'Gov.Pause', 'X-Transfer-Sequence': '1' }).join(), /reserved/);
  assert.match(bad({ Action: 'Gov.Pause', 'X-Dao-Id': '1' }).join(), /reserved/);
  assert.match(bad({ Action: 'Gov.Configure', 'Reveal-Window-Ms': '' }).join(), /non-empty/);
  assert.match(bad({ Action: 'Gov.Configure', 'Reveal-Window-Ms': 'a'.repeat(513) }).join(), /<= 512/);
  assert.match(bad({ Action: 'Gov.Configure', Bogus: '1' }).join(), /does not read/);
  assert.match(bad({ Action: 'Admin.Add-Validator' }).join(), /not a beacon action/);
  // Gov.Apply is anyone's message, never a proposal; Gov.Cancel is the DAO's.
  for (const gone of ['Gov.Handover', 'Gov.Apply']) {
    assert.match(bad({ Action: gone, Governor: pid('x') }).join(), /not a beacon action/, gone);
  }
  assert.deepEqual(bad({ Action: 'Gov.Cancel', 'Gov-Id': '3' }), []);
  // Money and code need Effective-At, at least the vote's end + 24 h (7 days for the reserve).
  const EA = { 'Effective-At': effectiveAt({ now: 1e12 }) };
  assert.equal(floorFor('Gov.Move-Reserve'), 7 * 86400000);
  assert.equal(floorFor('Gov.Set-Successor'), RESERVE_FLOOR_MS);
  assert.equal(floorFor('Gov.Treasury-Spend'), 86400000);
  for (const tags of [{ Action: 'Gov.Treasury-Spend', Recipient: pid('who'), Quantity: '1' }, { Action: 'Gov.Fund-Reserve', Quantity: '1' },
    { Action: 'Gov.Set-Successor', Successor: pid('n') }, { Action: 'Gov.Move-Reserve', Successor: pid('n') },
    { Action: 'Gov.Remove-Validator', Validator: pid('v') }, { Action: 'Gov.Configure', Slash: '1200' },
    { Action: 'Gov.Configure', 'Reveal-Window-Ms': '20000' }, { Action: 'Gov.Set-Dao', Dao: pid('dao2') },
    { Action: 'Gov.Approve-Code', 'Code-Root': 'a'.repeat(64) }, { Action: 'Gov.Configure', 'Max-Active': '8' },
    { Action: 'Gov.Configure', 'Min-Commits': '3' }]) {
    const floor = floorFor(tags.Action);
    const ea = { 'Effective-At': effectiveAt({ now: 1e12, floorMs: floor }) };
    assert.match(bad(tags).join(), /needs Effective-At/, tags.Action);
    assert.deepEqual(proposalErrors({ ...ok, execTags: { ...tags, ...ea } }, { token: pid('token'), now: 1e12 }), [], tags.Action);
    const early = { 'Effective-At': String(1e12 + 86400000 + floor - 1) };
    assert.match(proposalErrors({ ...ok, execTags: { ...tags, ...early } }, { token: pid('token'), now: 1e12 }).join(),
      floor === 86400000 ? /before the vote can end plus 24 h/ : /before the vote can end plus 7 d/, tags.Action);
  }
  assert.match(proposalErrors({ ...ok, execTags: { Action: 'Gov.Move-Reserve', Successor: pid('n'), ...EA } },
    { token: pid('token'), now: 1e12 }).join(), /plus 7 d/, 'the reserve waits a week, not a day');
  assert.deepEqual(bad({ Action: 'Gov.Configure', 'Request-Price': '5' }), [], 'prices are harmless');
  assert.match(bad({ Action: 'Gov.Pause', 'Effective-At': 'soon' }).join(), /whole milliseconds/);
  // gov.lua's verbs: Set-Dao and Approve-Code by vote; Renounce-Wallet is the wallet's alone.
  assert.deepEqual(bad({ Action: 'Gov.Set-Dao', Dao: pid('dao2'), ...EA }), []);
  assert.deepEqual(bad({ Action: 'Gov.Approve-Code', 'Code-Root': 'a'.repeat(64), ...EA }), []);
  assert.match(bad({ Action: 'Gov.Renounce-Wallet' }).join(), /not a beacon action/);
  assert.match(bad({ Action: 'Gov.Upgrade' }).join(), /not a beacon action/);
  assert.match(bad({ Action: 'Gov.Set-Dao', Governor: pid('x') }).join(), /does not read tag Governor/);
  assert.match(bad({ Action: 'Gov.Pause' }, { execProcess: pid('token') }).join(), /staked token/);
  assert.match(bad({ Action: 'Gov.Clear-Guardian' }).join(), /not a beacon action/);
  // The fast tier has its own Gov.* table.
  const fast = (execTags) => proposalErrors({ ...ok, execProcess: pid('fast'), execTags }, { token: pid('token'), fast: pid('fast') });
  assert.deepEqual(fast({ Action: 'Gov.Configure', 'Signer-Fee': '2' }), []);
  assert.match(fast({ Action: 'Gov.Claim-Protocol', Recipient: pid('who') }).join(), /needs Effective-At/);
  assert.deepEqual(fast({ Action: 'Gov.Claim-Protocol', Recipient: pid('who'), ...EA }), []);
  assert.match(fast({ Action: 'Gov.Configure', Threshold: '2' }).join(), /needs Effective-At/);
  assert.match(fast({ Action: 'Gov.Configure', 'Reveal-Window-Ms': '1' }).join(), /does not read/);
  assert.match(fast({ Action: 'Gov.Treasury-Spend', Recipient: pid('who'), Quantity: '1' }).join(), /not a fast-tier action/);
  assert.deepEqual(fast({ Action: 'Gov.Set-Dao', Dao: pid('dao2'), ...EA }), []);
  assert.match(bad({ Action: 'Gov.Claim-Protocol', Recipient: pid('who') }).join(), /not a beacon action/);
  // Fair play: Fair.Configure by tag, and the owner verbs.
  const fair = (execTags) => proposalErrors({ ...ok, execProcess: pid('fair'), execTags }, { token: pid('token'), fair: pid('fair') });
  assert.deepEqual(fair({ Action: 'Fair.Configure', Keep: '4', 'Max-Open': '9' }), []);
  assert.deepEqual(fair({ Action: 'Gov.Approve-Code', 'Code-Root': 'b'.repeat(64), ...EA }), []);
  assert.deepEqual(fair({ Action: 'Fair.Configure', 'Request-Price': '5' }), [], 'pay at deposit: harmless');
  assert.match(fair({ Action: 'Fair.Configure', Beacon: pid('beacon') }).join(), /needs Effective-At/);
  assert.match(fair({ Action: 'Fair.Configure', Data: '{}' }).join(), /reserved/);
  assert.match(fair({ Action: 'Gov.Pause' }).join(), /not a fair action/);
  const many = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`T${i}`, '1']));
  assert.match(bad({ Action: 'Gov.Configure', ...many }).join(), /more than 16/);
});

test('checkV3 passes on a healthy deployment and flags each problem', () => {
  const S = pid('sched');
  const s = { scheduler: S, token: pid('t'), dao: pid('d'), beacon: pid('b'), fair: pid('f'), predecessor: '',
    owners: { beacon: { dao: pid('d') }, fair: { dao: pid('d'), walletRenounced: true } },
    processes: Object.fromEntries([pid('t'), pid('d'), pid('b'), pid('f')].map((p) => [p, { scheduler: S }])) };
  const gov = (dao, wallet) => ({ dao, wallet, approved: '', code: '', version: 0 });
  const good = {
    tokeninfo: { Sealed: 'true', TotalSupply: '1000000000000000', ProcessTransferProtocol: 'sequenced-v1' },
    daoinfo: { Configured: true, Token: pid('t'), Admin: '' },
    beaconinfo: { token: pid('t'), self: pid('b'), predecessor: '', health: { status: 'ok' },
      foundationReserveAtoms: '200000000000000', gov: gov(pid('d'), true) },
    fairinfo: { beacon: pid('b'), token: pid('t'), requestPriceAtoms: 4000000, gov: gov(pid('d'), false) },
  };
  assert.deepEqual(checkV3({ state: s, ...good }).filter((c) => !c.ok), []);
  const failing = (patch) => checkV3({ state: s, ...good, ...patch }).filter((c) => !c.ok).map((c) => c.check);
  assert.deepEqual(failing({ tokeninfo: { ...good.tokeninfo, Sealed: 'false' } }), ['token sealed']);
  assert.deepEqual(failing({ beaconinfo: { ...good.beaconinfo, gov: gov('', true) } }), ['beacon owned by the DAO']);
  assert.deepEqual(failing({ beaconinfo: { ...good.beaconinfo, gov: undefined } }), ['beacon owned by the DAO']);
  assert.deepEqual(failing({ fairinfo: { ...good.fairinfo, gov: gov(pid('d'), true) } }), ['fair wallet renounced']);
  assert.deepEqual(failing({ fairinfo: { ...good.fairinfo, gov: gov(pid('x'), false) } }), ['fair owned by the DAO']);
  assert.deepEqual(failing({ beaconinfo: { ...good.beaconinfo, predecessor: pid('old') } }), ['beacon predecessor']);
  assert.deepEqual(failing({ beaconinfo: { ...good.beaconinfo, foundationReserveAtoms: '0' } }), ['beacon reserve funded']);
  assert.deepEqual(failing({ daoinfo: { ...good.daoinfo, Token: pid('x') } }), ['dao configured on RNG']);
  assert.deepEqual(failing({ fairinfo: { ...good.fairinfo, token: '' } }), ['fair paid in RNG']);
  // verify checks each protocol runs the build recorded for it (spawn: gov.code "" v0).
  const built = { ...s, expectedCode: { beacon: { code: '', version: 0 }, fair: { code: 'a'.repeat(64), version: 1 } } };
  const failingBuilt = (patch) => checkV3({ state: built, ...good, ...patch }).filter((c) => !c.ok).map((c) => c.check);
  assert.deepEqual(failingBuilt({ fairinfo: { ...good.fairinfo, gov: { ...gov(pid('d'), false), code: 'a'.repeat(64), version: 1 } } }), []);
  assert.deepEqual(failingBuilt({}), ['fair runs the recorded build']);
  assert.deepEqual(failingBuilt({ beaconinfo: { ...good.beaconinfo, gov: { ...gov(pid('d'), true), code: 'b'.repeat(64), version: 1 } },
    fairinfo: { ...good.fairinfo, gov: { ...gov(pid('d'), false), code: 'a'.repeat(64), version: 1 } } }), ['beacon runs the recorded build']);
  // A cold restore runs the spawn module: the installed root comes back approved, code "".
  const restored = buildErrors({ state: built, role: 'fair', info: { gov: { ...gov(pid('d'), false), approved: 'a'.repeat(64), version: 1 } } });
  assert.match(restored.join(), /cold restore: resend the installed code/);
});

test('dry-run plan prints the whole v3 sequence and sends nothing', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'deploy/deploy.mjs'), 'plan', '--dry-run'], {
    // An unreachable node: a dry run must not touch the network.
    env: { ...process.env, HB_NODE: 'http://127.0.0.1:9', HB_WALLET: '', RNG_DEPLOYER: DEPLOYER,
      RNG_SCHEDULER: pid('sched'), RNG_STATE: path.join(ROOT, 'deploy/does-not-exist.json') },
    encoding: 'utf8',
  });
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.every((l) => l.dryRun === true));
  const spawns = lines.filter((l) => l.op === 'spawn');
  assert.deepEqual(spawns.map((l) => l.role), ['token', 'dao', 'beacon', 'fair', 'fast']);
  assert.ok(spawns.every((l) => l.scheduler === pid('sched')), 'one scheduler');
  const [token, dao, beacon, fair, fast] = spawns.map((l) => l.pid);
  assert.equal(spawns[4].executionDevice, 'lua@5.3a');
  assert.match(spawns[0].prelude, new RegExp(`\\["${DEPLOYER}"\\] = 1000000000000000,`));
  assert.equal(spawns[1].definition['dao-token'], token);
  assert.equal(spawns[2].executionDevice, 'lua-patch@1.0');
  const sends = lines.filter((l) => l.op === 'send');
  const at = (action) => sends.findIndex((l) => l.action === action);
  const cfg = sends[at('Gov.Configure')];
  assert.equal(cfg.target, beacon);
  assert.deepEqual([cfg.data.token, cfg.data.self, cfg.data.predecessor], [token, beacon, '']);
  const transfers = sends.filter((l) => l.action === 'Transfer');
  assert.ok(transfers.every((l) => l.target === token));
  assert.deepEqual(transfers.find((l) => l.tags['X-Foundation']).tags.Quantity, '200000000000000');
  assert.deepEqual(transfers.find((l) => l.tags['X-Treasury']).tags.Quantity, '50000000000000');
  const float = transfers.find((l) => l.tags['X-For'] === fair);
  assert.equal(float.tags.Recipient, beacon);
  assert.equal(float.tags.Quantity, '40000000', 'fair float: 10 requests');
  // Fair play is open to any game: no allowlist step.
  assert.ok(sends.every((l) => l.action !== 'Fair.Configure' || !('allowGames' in (l.data || {}))));
  // The whole supply starts with Labs; reserve + treasury (250 M) are the DAO's, in the beacon.
  const daoControl = transfers.filter((l) => l.tags['X-Foundation'] || l.tags['X-Treasury'])
    .reduce((n, l) => n + BigInt(l.tags.Quantity), 0n);
  assert.equal(daoControl, 250_000_000_000_000n);
  // The one transfer to the DAO is RNG Labs' stake (a plain Transfer is a stake): 50,000,000 RNG by default.
  const stakes = transfers.filter((l) => l.tags.Recipient === dao);
  assert.deepEqual(stakes.map((l) => l.tags), [{ Recipient: dao, Quantity: String(LABS_STAKE_RNG * 1e6) }]);
  assert.equal(LABS_STAKE_RNG, 50_000_000);
  const bonds = transfers.filter((l) => l.tags['X-Bond']);
  assert.deepEqual(bonds.map((l) => l.tags['X-For']), readJson('deploy/anyhonest-validators.json'));
  assert.ok(bonds.every((l) => l.tags.Quantity === '100000000000'), 'operators bond 4 x stake');
  assert.deepEqual(sends[at('Fair.Configure')].data.beacon, beacon);
  assert.equal(sends[at('Fair.Configure')].data.token, token);
  assert.equal(sends[at('Fair.Configure')].data.requestPrice, readJson('deploy/v3-params.json').requestPrice);
  // Launch: the DAO becomes the only owner of every protocol and the wallet renounces in the same
  // step (after the stake), then each protocol is read back with gov.wallet false.
  const setDao = sends.filter((l) => l.action === 'Gov.Set-Dao');
  assert.deepEqual(setDao.map((l) => l.target), [beacon, fair, fast]);
  assert.ok(setDao.every((l) => JSON.stringify(l.tags) === JSON.stringify({ Dao: dao })), 'Dao tag only');
  assert.ok(at('Gov.Configure') < at('Gov.Set-Dao'));
  const renounce = sends.filter((l) => l.action === 'Gov.Renounce-Wallet');
  assert.deepEqual(renounce.map((l) => l.target), [beacon, fair, fast]);
  assert.ok(sends.indexOf(setDao[2]) < sends.indexOf(renounce[0]), 'set-dao on all, then renounce');
  assert.ok(sends.indexOf(stakes[0]) < sends.indexOf(setDao[0]), 'Labs stakes before the handover');
  assert.ok(bonds.every((b) => sends.indexOf(b) > sends.indexOf(renounce[2])), 'validators bond only after the wallet renounced');
  const owners = lines.filter((l) => l.op === 'check' && l.owners);
  assert.deepEqual(owners.map((l) => [l.role, l.owners.dao, l.owners.wallet]),
    [['beacon', dao, false], ['fair', dao, false], ['fast', dao, false]]);
  assert.ok(lines.indexOf(owners[2]) < lines.findIndex((l) => l.action === 'Propose'), 'verified before the first proposal');
  for (const gone of ['Gov.Handover', 'Gov.Apply', 'Gov.Cancel']) assert.equal(at(gone), -1, gone);
  // The fast tier: genesis on the existing committee and the v3 token, then owned by the DAO alone.
  const fastCfg = sends.find((l) => l.target === fast && l.action === 'Gov.Configure');
  const committee = readJson('deploy/committee.json');
  assert.deepEqual([fastCfg.data.self, fastCfg.data.token, fastCfg.data.threshold, fastCfg.data.groupKey],
    [fast, token, committee.t, committee.groupKey]);
  assert.deepEqual(fastCfg.data.committee, committee.members);
  assert.deepEqual(fastCfg.data.sharePublicKeys, committee.sharePublicKeys);
  assert.ok(!('cadenceMs' in fastCfg.data), 'no cadence: on demand');
  assert.ok(sends.indexOf(fastCfg) < sends.indexOf(setDao[2]));
  const propose = sends[at('Propose')];
  assert.ok(sends.indexOf(setDao[2]) < at('Propose'), 'the proof proposal follows Set-Dao');
  assert.equal(propose.target, dao);
  assert.equal(propose.tags['Exec-Process'], beacon);
  for (const gone of ['Configure', 'Admin.Add-Validator', 'Admin.Reinstate', 'Admin.Mint', 'Faucet', 'Claim-Protocol']) {
    assert.equal(at(gone), -1, `${gone} is not part of v3`);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'deploy/does-not-exist.json')), false, 'dry run writes no state');
});

test('legacy commands target the live v2 beacon from the read-only inventory', () => {
  const run = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'deploy/deploy.mjs'), ...args, '--dry-run'], {
    env: { ...process.env, HB_NODE: 'http://127.0.0.1:9', HB_WALLET: '', RNG_DEPLOYER: DEPLOYER }, encoding: 'utf8' });
  const before = fs.readFileSync(path.join(ROOT, 'deploy/native-testnet.json'), 'utf8');
  const succ = JSON.parse(run('legacy-set-successor', state.anyHonest, pid('v3')));
  assert.deepEqual([succ.target, succ.action, succ.data], [state.anyHonest, 'Admin.Set-Successor', { successor: pid('v3') }]);
  const tune = JSON.parse(run('legacy-tune', 'commitWindowMs=5000'));
  assert.deepEqual([tune.target, tune.action, tune.data], [state.anyHonest, 'Configure', { commitWindowMs: 5000 }]);
  assert.equal(fs.readFileSync(path.join(ROOT, 'deploy/native-testnet.json'), 'utf8'), before);
});

test('no guardian anywhere: beacon, deploy script, templates', () => {
  for (const f of ['protocol/beacon/anyhonest.lua', 'protocol/beacon/beacon.lua', 'deploy/deploy.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /guardianUntil|isGuardian|Clear-Guardian|RNG_GUARDIAN|--no-guardian|GUARDIAN_MS/, f);
  }
});

test('fast genesis takes the existing committee and refuses a bad one', () => {
  const committee = readJson('deploy/committee.json');
  const d = fastGenesisConfig({ fast: pid('fast'), token: pid('token'), committee });
  assert.deepEqual([d.unit, d.verification, d.signerFee, d.protocolFee], [1_000_000, 'attestations', 1, 1]);
  const bad = (patch) => () => fastGenesisConfig({ fast: pid('fast'), token: pid('token'), committee: { ...committee, ...patch } });
  assert.throws(bad({ t: 1 }), /t must be/);
  assert.throws(bad({ t: 4 }), /t must be/);
  assert.throws(bad({ members: [committee.members[0], committee.members[0], committee.members[1]] }), /distinct/);
  assert.throws(bad({ sharePublicKeys: committee.sharePublicKeys.slice(0, 2) }), /one 96-hex key per member/);
  assert.throws(bad({ groupKey: 'ab' }), /groupKey/);
  assert.throws(() => fastGenesisConfig({ fast: 'x', token: pid('token'), committee }), /ids/);
});

test('fund-fast and gov-fast dry-run against the fast tier', () => {
  const tmp = path.join(ROOT, 'deploy', `.fast-test-${process.pid}.json`);
  const S = pid('sched');
  fs.writeFileSync(tmp, JSON.stringify({ scheduler: S, token: pid('token'), dao: pid('dao'), fast: pid('fast'),
    processes: { [pid('token')]: { scheduler: S }, [pid('dao')]: { scheduler: S }, [pid('fast')]: { scheduler: S } } }));
  try {
    const run = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'deploy/deploy.mjs'), ...args, '--dry-run'], {
      env: { ...process.env, HB_NODE: 'http://127.0.0.1:9', HB_WALLET: '', RNG_DEPLOYER: DEPLOYER, RNG_SCHEDULER: S,
        RNG_STATE: tmp }, encoding: 'utf8' }).trim().split('\n').map((l) => JSON.parse(l));
    const [fund] = run('fund-fast', '9');
    assert.deepEqual([fund.target, fund.action, fund.tags.Recipient, fund.tags.Quantity, fund.tags['X-For']],
      [pid('token'), 'Transfer', pid('fast'), '9000000', DEPLOYER]);
    const [gov] = run('gov-fast', 'Gov.Configure', 'Signer-Fee=2');
    assert.deepEqual([gov.target, gov.action, gov.tags], [pid('fast'), 'Gov.Configure', { 'Signer-Fee': '2' }]);
    const [h] = run('set-dao', 'fast');
    assert.deepEqual([h.target, h.action, h.tags], [pid('fast'), 'Gov.Set-Dao', { Dao: pid('dao') }]);
    assert.throws(() => run('gov-fast', 'Gov.Set-Dao', `Dao=${pid('x')}`), /use `set-dao fast`/);
    assert.throws(() => run('gov-fast', 'Gov.Renounce-Wallet'), /renounce-wallet fast/);
    assert.throws(() => run('handover-fast'), /unknown command/);
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('set-dao and renounce-wallet: every protocol, in order, recorded, one way', () => {
  const tmp = path.join(ROOT, 'deploy', `.owners-test-${process.pid}.json`);
  const S = pid('sched');
  const procs = ['token', 'dao', 'beacon', 'fair', 'fast'];
  fs.writeFileSync(tmp, JSON.stringify({ scheduler: S, ...Object.fromEntries(procs.map((r) => [r, pid(r)])),
    processes: Object.fromEntries(procs.map((r) => [pid(r), { scheduler: S }])) }));
  try {
    const run = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'deploy/deploy.mjs'), ...args, '--dry-run'], {
      env: { ...process.env, HB_NODE: 'http://127.0.0.1:9', HB_WALLET: '', RNG_DEPLOYER: DEPLOYER, RNG_SCHEDULER: S,
        RNG_STATE: tmp }, encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').map((l) => JSON.parse(l));
    const all = run('set-dao');
    assert.deepEqual(all.map((l) => [l.target, l.action, l.tags]),
      PROTOCOL_ROLES.map((r) => [pid(r), 'Gov.Set-Dao', { Dao: pid('dao') }]));
    // A dry run records nothing, so a renounce in the same dry state is refused.
    assert.throws(() => run('renounce-wallet', 'beacon'), /set-dao beacon first/);
    assert.throws(() => run('renounce-wallet'), /renounce-wallet <beacon\|fair\|fast/);
    assert.throws(() => run('set-dao', 'token'), /not a governed protocol/);
    assert.throws(() => run('gov', 'Gov.Renounce-Wallet'), /use `set-dao` \/ `renounce-wallet`/);
    assert.throws(() => run('handover', '--confirm'), /unknown command/);
    const st = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    st.owners = { beacon: { dao: pid('dao') } };
    fs.writeFileSync(tmp, JSON.stringify(st));
    const [r] = run('renounce-wallet', 'beacon');
    assert.deepEqual([r.target, r.action, r.tags], [pid('beacon'), 'Gov.Renounce-Wallet', {}]);
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('set-dao is refused onto a wallet, a foreign DAO, another scheduler or a renounced protocol', () => {
  const S = pid('sched');
  const s = { scheduler: S, token: pid('t'), dao: pid('d'), beacon: pid('b'),
    processes: { [pid('t')]: { scheduler: S }, [pid('d')]: { scheduler: S }, [pid('b')]: { scheduler: S } } };
  const info = { token: pid('t'), gov: { dao: '', wallet: true, approved: '', code: '', version: 0 } };
  const daoinfo = { Standard: 'stake-dao/1', Configured: true, Token: pid('t'), Admin: '' };
  const ok = { state: s, role: 'beacon', info, daoinfo, me: DEPLOYER };
  assert.deepEqual(setDaoErrors(ok), []);
  const why = (patch) => setDaoErrors({ ...ok, ...patch }).join('; ');
  assert.match(why({ daoinfo: null }), /no daoinfo: not a live DAO process/);
  assert.match(why({ state: { ...s, dao: DEPLOYER, processes: { ...s.processes, [DEPLOYER]: { scheduler: S } } } }), /deployer wallet/);
  assert.match(why({ state: { ...s, dao: undefined } }), /spawn-dao first/);
  assert.match(why({ daoinfo: { ...daoinfo, Standard: 'other/1' } }), /not stake-dao\/1/);
  assert.match(why({ daoinfo: { ...daoinfo, Token: pid('x') } }), /not configured on our token/);
  assert.match(why({ daoinfo: { ...daoinfo, Admin: pid('a') } }), /has an admin/);
  assert.match(why({ state: { ...s, processes: { ...s.processes, [pid('d')]: { scheduler: pid('other') } } } }),
    /from-process would not be believed/);
  assert.match(why({ info: null }), /publishes no beaconinfo/);
  assert.match(why({ info: { ...info, token: '' } }), /not configured on the token/);
  assert.match(why({ info: { token: pid('t') } }), /publishes no gov/);
  assert.match(why({ info: { ...info, gov: { ...info.gov, wallet: false, dao: pid('x') } } }), /no longer answers to the wallet/);
  assert.deepEqual(setDaoErrors({ ...ok, info: { ...info, gov: { ...info.gov, wallet: false, dao: pid('d') } } }), [],
    'the same DAO again is harmless');
  assert.match(why({ role: 'token' }), /not a governed protocol/);
  assert.deepEqual(INFO_KEY, { beacon: 'beaconinfo', fair: 'fairinfo', fast: 'beaconinfo' });
});

test('renounce-wallet is refused until the protocol reads the DAO as owner', () => {
  const s = { dao: pid('d'), beacon: pid('b'), token: pid('t'), expectedCode: { beacon: { code: '', version: 0 } } };
  const gov = (dao, wallet, extra = {}) => ({ token: pid('t'), govPending: [],
    gov: { dao, wallet, approved: '', code: '', version: 0, ...extra } });
  const daoinfo = { Standard: 'stake-dao/1', Configured: true, Token: pid('t'), Admin: '' };
  const why = (info, patch = {}) => renounceErrors({ state: s, role: 'beacon', info, daoinfo, ...patch }).join('; ');
  assert.deepEqual(renounceErrors({ state: s, role: 'beacon', info: gov(pid('d'), true), daoinfo }), []);
  // Nothing set going may outlive the wallet, and the DAO must be ours.
  assert.match(why({ ...gov(pid('d'), true), govPending: [{ id: 1, verb: 'Gov.Set-Dao' }] }), /1 pending action\(s\) \(1\)/);
  assert.match(why(gov(pid('d'), true, { approved: 'c'.repeat(64) })), /approved: cancel it first/);
  assert.match(why(gov(pid('d'), true, { code: 'c'.repeat(64), version: 1 })), /not the recorded build/);
  assert.match(why(gov(pid('d'), true), { state: { ...s, expectedCode: undefined } }), /no audited build recorded/);
  assert.match(why(gov(pid('d'), true), { daoinfo: null }), /no daoinfo/);
  assert.match(why(gov(pid('d'), true), { daoinfo: { ...daoinfo, Token: pid('x') } }), /not a configured stake-dao\/1 on our token/);
  assert.match(why(gov(pid('d'), true), { daoinfo: { ...daoinfo, Standard: 'other/1' } }), /stake-dao\/1/);
  assert.match(why({ ...gov(pid('d'), true), govPending: undefined }), /no govPending/);
  assert.match(renounceErrors({ state: s, role: 'beacon', info: gov('', true) }).join(), /set-dao beacon first/);
  assert.match(renounceErrors({ state: s, role: 'beacon', info: gov(pid('x'), true) }).join(), /set-dao beacon first/);
  assert.match(renounceErrors({ state: s, role: 'beacon', info: gov(pid('d'), false) }).join(), /no wallet owner left/);
  assert.match(renounceErrors({ state: s, role: 'beacon', info: null }).join(), /publishes no beaconinfo/);
  assert.match(renounceErrors({ state: { ...s, dao: undefined }, role: 'beacon', info: gov('', true) }).join(), /set-dao/);
});

test('dao-watch flags every open proposal (and a missing Labs vote) and every pending action', () => {
  const proposals = [{ id: 3, status: 'active', title: 'a' }, { id: 4, status: 'active', title: 'b' }, { id: 2, status: 'passed' }];
  const alerts = watchAlerts({ proposals, stake: { votes: { 3: 'Yes' } },
    infos: { beacon: { govPending: [{ id: 7, verb: 'Gov.Treasury-Spend', class: 'money' }] }, fair: { govPending: [] }, fast: null } });
  assert.deepEqual(alerts.map((a) => a.what), ['proposal 3 open (Labs voted Yes)', 'proposal 4 open: Labs has NOT voted',
    'beacon pending 7 Gov.Treasury-Spend (money)']);
  assert.deepEqual(watchAlerts({ proposals: [], infos: {} }), []);
});

test('live rate: 5-minute average from timelockhistory, p50 latency, checks and the watch alert', () => {
  const history = { keep: 1024, rounds: Array.from({ length: 1000 }, (_, i) => [i + 1, 10 * (i + 1)]) };
  history.rounds[399] = [400, 4000, 'abandoned'];
  assert.deepEqual(historyPoint(history), [399, 3990], '~600 rounds back, abandoned skipped');
  assert.equal(historyPoint({ rounds: [[1, 1]] }), null);
  const recent = [{ opened: 1000, finalizedAt: 1600 }, { opened: 2000, finalizedAt: 2800 }, { opened: 3000, finalizedAt: 3700 }];
  const fast = beaconRate({ then: { round: 400, at: 0 }, now: { round: 1000, at: 300_000 }, recent });
  assert.deepEqual(fast, { rate: 2, windowMs: 300_000, p50LatencyMs: 700 });
  assert.deepEqual(rateChecks(fast).map((c) => c.ok), [true, true]);
  assert.equal(MIN_RATE, 1.8);
  const slow = beaconRate({ then: { round: 400, at: 0 }, now: { round: 580, at: 300_000 }, recent: [{ opened: 1, finalizedAt: 5201 }] });
  assert.deepEqual(rateChecks(slow).map((c) => c.ok), [false, false], '0.6/s, latency 5.2 s');
  assert.equal(rateChecks(slow, { minRate: 0.5 })[0].ok, true, 'threshold configurable');
  assert.deepEqual(rateChecks(beaconRate({ then: null, now: { round: 1, at: 1 }, recent: [] })).map((c) => c.ok), [false, false], 'unknown fails');
  assert.deepEqual(watchAlerts({ proposals: [], infos: {}, rate: slow }).map((a) => a.what), ['beacon slow: 0.60 rounds/s (want >= 1.8)']);
  assert.deepEqual(watchAlerts({ proposals: [], infos: {}, rate: fast }), []);
});

test('the deployer allocation gives the whole supply to the deployer, ticker RNG', () => {
  const spec = readJson('deploy/allocations-deployer.json');
  const a = loadAllocations(spec, { deployer: DEPLOYER });
  assert.deepEqual(Object.keys(a.table), [DEPLOYER]);
  assert.equal(a.table[DEPLOYER], SUPPLY_ATOMS);
  assert.equal(a.ticker, 'RNG');
  assert.deepEqual([a.reserveRng, a.treasuryRng, a.validatorRng], [200_000_000, 50_000_000, 100_000]);
  assert.doesNotMatch(genesisPrelude(a), /TokenTicker/, 'the token keeps its own name and ticker, RNG');
  for (const f of ['deploy/v3-genesis.json', 'deploy/allocations-deployer.json']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /TEST-/, f);
  }
});

// gov.lua is paralith-mono's plus Effective-At, the pending queue and the exit hatch
// (protocol/vendor/SOURCE); sha256.lua is unchanged.
test('vendored sha256.lua is paralith-mono\'s, byte for byte', (t) => {
  const pm = process.env.PARALITH_MONO;
  if (!pm || !fs.existsSync(path.join(pm, 'backend/native/sha256.lua'))) {
    return t.skip('optional: set PARALITH_MONO to a paralith-mono tree with backend/native/sha256.lua (ours is canonical)');
  }
  for (const f of ['sha256.lua']) {
    const norm = (s) => s.replace(/\r\n/g, '\n');
    assert.equal(norm(fs.readFileSync(path.join(ROOT, 'protocol/vendor', f), 'utf8')),
      norm(fs.readFileSync(path.join(pm, 'backend/native', f), 'utf8')), `protocol/vendor/${f} differs from ${pm}`);
  }
});

test('every protocol bundle carries gov.lua ahead of the contract, and the beacons publish gov', () => {
  for (const [name, build] of Object.entries(protocolSources)) {
    const src = build();
    const gov = src.indexOf('function Gov.handle(');
    const sha = src.indexOf('Sha256 = {}');
    assert.ok(sha !== -1 && gov > sha, `${name}: sha256.lua then gov.lua`);
    const contract = { anyHonest: 'function compute(base, req)', fair: 'function compute(base, req)',
      fast: 'function compute(base, req, opts)' }[name];
    assert.ok(src.indexOf(contract) > gov, `${name}: gov.lua before the contract`);
    assert.doesNotMatch(src, /GOV_DELAY_MS|Gov\.Handover"/, `${name}: no old queue left`);
    assert.match(src, /Gov\.EXIT_FLOOR_MS = DAY_MS/, `${name}: the 24 h floor is a constant`);
  }
});

test('fund-fast refuses a fast tier that has not run genesis-configure-fast', () => {
  const s = { token: pid('t'), fast: pid('f') };
  assert.equal(fundError({ state: s, beaconinfo: { token: pid('t') }, role: 'fast' }), null);
  assert.match(fundError({ state: s, beaconinfo: { token: '' }, role: 'fast' }), /genesis-configure-fast/);
});

test('fund-* refuses a beacon that has not run genesis-configure', () => {
  const s = { token: pid('t'), beacon: pid('b') };
  assert.equal(fundError({ state: s, beaconinfo: { token: pid('t') } }), null);
  assert.match(fundError({ state: s, beaconinfo: { token: '' } }), /strand/);
  assert.match(fundError({ state: s, beaconinfo: null }), /strand/);
});

test('every protocol schedules the DAO\'s money and code through gov.lua\'s floor', () => {
  for (const f of ['protocol/beacon/anyhonest.lua', 'protocol/beacon/beacon.lua', 'protocol/fair/fair.lua']) {
    const lua = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(lua, /GOV_DELAY_MS|TIMELOCKED_PARAMS|H\["Gov\.Handover"\]/, f);
    assert.match(lua, /Gov\.ownerOf\(base/, `${f} takes its owners from gov.lua`);
    assert.match(lua, /Gov\.when\(/, `${f} checks Effective-At with gov.lua`);
    assert.match(lua, /Gov\.hatchOpen\(/, `${f} publishes the exit hatch`);
  }
  const gov = fs.readFileSync(path.join(ROOT, 'protocol/vendor/gov.lua'), 'utf8');
  assert.match(gov, /^Gov\.EXIT_FLOOR_MS = DAY_MS$/m, 'the floor is a literal constant');
  assert.match(fs.readFileSync(path.join(ROOT, 'protocol/beacon/anyhonest.lua'), 'utf8'), /SPEND_WINDOW_MS = 30 \* DAY_MS/);
  const move = readJson('deploy/proposals/004-move-reserve.json');
  assert.equal(move.execTags.Successor, '$SUCCESSOR', 'Move-Reserve names its successor');
});

test('the deploy bundles answer the owner verbs: raw replies from fair, fast and the beacon', async (t) => {
  const wasm = process.env.AOS_WASM
    || path.join(process.env.PARALITH_ROOT || 'C:/REPO/paralith-mono', 'backend/native/module/AOS.wasm');
  if (!fs.existsSync(wasm)) return t.skip('AOS.wasm not available');
  const { default: AoLoader } = await import('@permaweb/ao-loader');
  const OWNER = pid('owner'), SCHED = pid('sched'), DAO = pid('dao'), SELF = 'p'.repeat(43);
  const driver = `
Owner = nil
local base = { ["scheduler-location"] = "${SCHED}",
  process = { commitments = { p = { type = "rsa-pss-sha512", committer = "${OWNER}" } } } }
local slot = 0
local function send(signer, fields, fromProcess)
  local body = { target = "${SELF}", commitments = { c = { type = "rsa-pss-sha512", committer = signer,
    committed = { "target", "action" } } } }
  for k, v in pairs(fields) do body[k] = v end
  body["from-process"] = fromProcess
  slot = slot + 1
  base = compute(base, { body = body, timestamp = 1700000000000 + slot, process = "${SELF}", slot = slot })
  return base.results.output.data
end
local out = {}
out[#out + 1] = send("${pid('stranger')}", { Action = "Gov.Set-Dao", Dao = "${DAO}" })
out[#out + 1] = send("${OWNER}", { Action = "Gov.Renounce-Wallet" })
out[#out + 1] = send("${OWNER}", { Action = "Gov.Set-Dao", Dao = "${DAO}" })
out[#out + 1] = send("${SCHED}", { Action = "Gov.Approve-Code", ["Code-Root"] = string.rep("c", 64) }, "${DAO}")
out[#out + 1] = send("${SCHED}", { Action = "Gov.Approve-Code", ["Code-Root"] = string.rep("c", 64),
  ["Effective-At"] = "1700086400005" }, "${DAO}")
out[#out + 1] = send("${OWNER}", { Action = "Gov.Renounce-Wallet" })
out[#out + 1] = send("${SCHED}", { Action = "Gov.Cancel", ["Gov-Id"] = "code" }, "${DAO}")
out[#out + 1] = send("${OWNER}", { Action = "Gov.Renounce-Wallet" })
out[#out + 1] = send("${OWNER}", { Action = "Gov.Set-Dao", Dao = "${OWNER}" })
return table.concat(out, "\\n")`;
  const want = [
    '{"error":"Not authorised","ok":false}',
    '{"error":"Set a DAO first","ok":false}',
    `{"dao":"${DAO}","ok":true}`,
    '{"error":"Effective-At-Required","ok":false}',
    `{"approved":"${'c'.repeat(64)}","effectiveAt":1700086400005,"ok":true}`,
    // Nothing pending may outlive the wallet: cancel it first.
    '{"error":"Gov-Queue-Not-Empty","ok":false}',
    '{"cancelled":"code"}',
    '{"ok":true,"wallet":false}',
    '{"error":"Not authorised","ok":false}',
  ].join('\n');
  for (const [name, build] of Object.entries(protocolSources)) {
    const handle = await AoLoader(fs.readFileSync(wasm), { format: 'wasm32-unknown-emscripten', computeLimit: 9e12, memoryLimit: 512 * 1024 * 1024 });
    const id = pid(`bundle-${name}`);
    const r = await handle(null, {
      Id: `eval-${name}`, Target: id, Owner: id, From: id, Tags: [{ name: 'Action', value: 'Eval' }],
      Data: `${build()}\n${driver}`, 'Block-Height': '1', Timestamp: '1700000000000', Module: 'aos', Cron: false,
    }, { Process: { Id: id, Owner: id, Tags: [] }, Module: { Id: 'aos', Tags: [] } });
    assert.equal(r.Error, undefined, `${name}: ${r.Error}`);
    const out = r.Output?.data;
    assert.equal(typeof out === 'string' ? out : out?.output, want, name);
  }
});

test('spawn-dao --lua53b --dry-run builds the RNG DAO from PARALITH_MONO, named without TEST-', (t) => {
  const pm = process.env.PARALITH_MONO;
  if (!pm || !fs.existsSync(path.join(pm, 'backend/native/dao.lua'))) {
    return t.skip('optional: set PARALITH_MONO to build the stake-dao/1 module (spawn-dao --dry-run needs none)');
  }
  const tmp = path.join(ROOT, 'deploy', `.dao-test-${process.pid}.json`);
  const S = pid('sched');
  fs.writeFileSync(tmp, JSON.stringify({ scheduler: S, token: pid('token'), tokenTicker: 'RNG',
    processes: { [pid('token')]: { scheduler: S } } }));
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'deploy/deploy.mjs'), 'spawn-dao', '--lua53b', '--dry-run'], {
      env: { ...process.env, HB_NODE: 'http://127.0.0.1:9', HB_WALLET: '', RNG_DEPLOYER: DEPLOYER, RNG_SCHEDULER: S,
        RNG_STATE: tmp }, encoding: 'utf8' });
    const l = JSON.parse(out.trim());
    assert.equal(l.executionDevice, 'lua-patch@1.0');
    assert.equal(l.definition['dao-name'], 'RNG DAO');
    assert.equal(l.definition['dao-ticker'], 'RNG');
    assert.equal(l.definition['dao-token'], pid('token'));
    assert.equal(path.resolve(l.module.from), path.resolve(pm));
    assert.ok(l.module.sourceBytes > 10000 && /^[0-9a-f]{64}$/.test(l.module.sourceSha256));
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('relaunch: spawn-<role> --replace retires the old process; dao-handover takes a subset', () => {
  // Pure: the old id, its owners and build move to `retired`; the role starts fresh.
  const st = JSON.parse(JSON.stringify(live));
  const before = (st.retired || []).length;
  const oldFast = st.fast;
  const e = retireRole(st, 'fast', '2026-11-07T00:00:00.000Z');
  assert.deepEqual([e.role, e.pid, e.owners.walletRenounced, e.expectedCode.version], ['fast', oldFast, true, 0]);
  assert.deepEqual([st.fast, st.owners.fast, st.expectedCode.fast], [undefined, undefined, undefined]);
  assert.equal(st.processes[oldFast].retired, '2026-11-07T00:00:00.000Z');
  assert.equal(st.owners.beacon.walletRenounced, true, 'other roles untouched');
  retireRole(st, 'fair');
  assert.deepEqual(st.retired.slice(before).map((r) => r.role), ['fast', 'fair']);
  assert.equal(retireRole(st, 'fair'), null, 'nothing to retire twice');

  // Dry runs over a copy of the live state: only the fast tier and fair process move.
  const tmp = path.join(ROOT, 'deploy', `.relaunch-test-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(live));
  try {
    const run = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'deploy/deploy.mjs'), ...args, '--dry-run'], {
      env: { ...process.env, HB_NODE: 'http://127.0.0.1:9', HB_WALLET: '', RNG_DEPLOYER: live.deployer || DEPLOYER,
        RNG_SCHEDULER: live.scheduler, RNG_STATE: tmp }, encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').map((l) => JSON.parse(l));
    assert.throws(() => run('spawn-fast'), /already deployed/);
    const fast = run('spawn-fast', '--replace');
    assert.deepEqual([fast[0].op, fast[0].pid], ['retire', live.fast]);
    assert.equal(fast[1].op, 'spawn');
    const fair = run('spawn-fair', '--replace');
    assert.deepEqual([fair[0].op, fair[0].pid], ['retire', live.fair]);
    const h = run('dao-handover', 'fast', 'fair', '--confirm');
    assert.deepEqual(h.filter((l) => l.op === 'send').map((l) => [l.target, l.action]),
      [[live.fast, 'Gov.Set-Dao'], [live.fair, 'Gov.Set-Dao'], [live.fast, 'Gov.Renounce-Wallet'], [live.fair, 'Gov.Renounce-Wallet']]);
    assert.equal(fs.readFileSync(tmp, 'utf8'), JSON.stringify(live), 'dry runs write no state');
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('live rate from now/beaconinfo samples only (the node keeps ~5 min of slots)', () => {
  let samples = [];
  const t0 = 1_700_000_000_000;
  samples = addRateSample(samples, { round: 1000, at: t0 });
  assert.equal(rateBase(samples, { round: 1000, at: t0 }), null, 'one sample: nothing to measure against');
  samples = addRateSample(samples, { round: 1060, at: t0 + 30_000 });
  assert.equal(rateBase(samples, { round: 1060, at: t0 + 30_000 }), null, 'under 60 s apart: not yet');
  for (let s = 1; s <= 20; s++) samples = addRateSample(samples, { round: 1000 + 120 * s, at: t0 + 60_000 * s });
  const now = samples.at(-1);
  const then = rateBase(samples, now);
  assert.equal(now.at - then.at, 300_000, 'the sample nearest 5 minutes back');
  const r = beaconRate({ then, now, recent: [] });
  assert.equal(r.rate, 2);
  assert.ok(samples[0].at >= now.at - 900_000, 'only the last 15 minutes are kept');
  assert.equal(addRateSample(samples, null).length, samples.length, 'an unreadable info adds nothing');
});

test('code-root matches gov.lua: one part is sha256(hex(sha256(code))); parts end on a character boundary', async () => {
  const { codeRoot, GOV_PART_MAX } = await import('../deploy.mjs');
  const { createHash } = await import('node:crypto');
  const h = (b) => createHash('sha256').update(b).digest('hex');
  assert.equal(codeRoot('print(1)').root, h(h('print(1)')));
  const code = 'a'.repeat(GOV_PART_MAX - 1) + '—' + 'b'.repeat(10);
  const { parts, manifest, root } = codeRoot(code);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= GOV_PART_MAX));
  assert.equal(Buffer.concat(parts).toString('utf8'), code);
  assert.equal(parts[1].toString('utf8')[0], '—');
  assert.equal(root, h(manifest));
});
