// Deploy and drive Any-Honest v3: fixed-supply RNG, the RNG DAO (YapDAO
// stake-dao/1), the permissionless beacon and fair play. docs/PERMISSIONLESS.md.
//
// v3 (state: RNG_STATE, default deploy/v3-testnet.json):
//   spawn-token <allocations.json>          RNG with GenesisAllocations (sealed after slot 1)
//   spawn-dao [--lua53b]                    the RNG DAO, stake-dao/1 staking RNG (needs PARALITH_MONO)
//   spawn-beacon [--lua53a]                 the v3 beacon (lua-patch@1.0 by default)
//   genesis-configure [params.json]         deployer Gov.Configure naming the token (locks token/unit/self/predecessor)
//   fund-reserve <rng> | fund-treasury <rng>  deployer Transfer with X-Foundation / X-Treasury
//   fund <rng> [for]                        a beacon balance (X-For)
//   spawn-fair | configure-fair [windowMs]  fair play (token, beacon requestPrice from v3-params.json)
//   fund-fair <rng>                         the fair process's beacon float (X-For = fair; not spent:
//                                           every bound batch is topped up from the games' balances)
//   fund-game <rng> <game>                  prepay a game's fair-play balance (X-Fair-Game); any game
//   grant <address> <rng>                   plain RNG transfer from the deployer
//   bond-for <rng> <address...|validators.json>  Transfer X-Bond X-For each validator
//   gov <Gov.Action> [Tag=Value ...]        any wallet-path Gov.* on the beacon (Pause, Resume, Set-Successor, ...)
//   resend-ack                              Resend-Successor-Ack to the predecessor
// Owners (vendor/gov.lua). The launch wallet bootstraps; at launch the DAO becomes the ONLY owner.
// The DAO's money/code actions carry Effective-At >= receipt + 24 h (dao-propose fills $EFFECTIVE_AT)
// and anyone applies them once due (gov-apply); harmless ones apply on receipt:
//   dao-handover [beacon|fair|fast ...] --confirm   set-dao then renounce-wallet on each (default: every
//                                           deployed protocol), then reads back gov.dao = DAO, gov.wallet = false.
//   set-dao [beacon|fair|fast ...]          Gov.Set-Dao naming the recorded DAO (default: every deployed
//                                           protocol). Refused unless the DAO is a live stake-dao/1 on our
//                                           token with no admin, on our scheduler; reads gov.dao back.
//   renounce-wallet <beacon|fair|fast ...> --confirm   Gov.Renounce-Wallet (one way). Refused unless the
//                                           protocol already reads the recorded DAO as owner; reads back.
//   gov-apply <beacon|fair|fast> <Gov-Id>   Gov.Apply: anyone runs a pending DAO action once it is due
//   watch (alias dao-watch)                 every open DAO proposal (and whether Labs has voted on it), every
//                                           pending action on beacon, fair, fast, and a slow beacon (5-minute
//                                           average < RNG_MIN_RATE, default 1.8 rounds/s); exits 1 when one needs a look
//   expect-code <beacon|fair|fast> <root> <version>   record an upgrade the DAO installed as the build verify expects
// Fast tier (on-demand 2-of-3 threshold BLS, beacon/beacon.lua; not a heartbeat):
//   spawn-fast                              the fast-tier process (lua@5.3a)
//   genesis-configure-fast [committee.json] deployer Gov.Configure: v3 token, the existing committee
//                                           (deploy/committee.json), fees; locks token/unit/self
//   fund-fast <rng> [for]                   a fast-tier balance (X-For)
//   gov-fast <Gov.Action> [Tag=Value ...]   any wallet-path Gov.* on the fast tier
//   dao-stake [rng] (default: Labs' launch stake) | dao-propose <template.json> [KEY=VALUE ...] | dao-vote <id> <Yes|No|NoWithVeto|Abstain>
//   status | verify                         read and check token, DAO, beacon, fair (verify exits 1 on a failure;
//                                           it checks each protocol runs the recorded build: gov.code/version,
//                                           the beacon's 5-minute rate >= RNG_MIN_RATE (default 1.8 rounds/s)
//                                           and its round latency p50 < commitWindowMs/2)
//   test-subscription                       authenticated-push acceptance test against the v3 beacon
//   smoke [--n N] [--only A,B] [--load 30]  live end-to-end test through the client libraries (deploy/smoke.mjs);
//                                           spends at most 2,000 RNG, only to the beacon, fast tier and fair
//   plan <allocations.json> [params.json]   the whole v3 sequence, dry-run only
//
// Legacy, against the LIVE v2 beacon until cutover (state: RNG_LEGACY_STATE,
// default deploy/native-testnet.json, never written):
//   legacy-info | legacy-tune key=int ... | legacy-reinstate [address ...]
//   legacy-bond [units] [address ...]       old TEST-RNG X-Bond on the v2 beacon
//   legacy-set-successor <old> <new>        Admin.Set-Successor (v2 wallet path)
//   legacy-move-reserve <old>               Admin.Move-Reserve; refused across tokens
//   legacy-request [id] | legacy-verify [round] | legacy-beacon-info   the OLD threshold process (state.beacon
//                                           in native-testnet.json, on the old TEST-RNG); retired at launch
//
// --dry-run (or RNG_DRY_RUN=1) prints every spawn and message as one JSON line
// and sends nothing; it never writes state. RNG_DEPLOYER stands in for the
// wallet's address, RNG_SCHEDULER for the node's.
//
// Env: HB_NODE, HB_WALLET (deployer), RNG_STATE, RNG_LEGACY_STATE, RNG_SCHEDULER
//      (pin; must equal the node's), PARALITH_MONO (for spawn-dao).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// LF only: a bundle (and its code root) is the same bytes on every checkout.
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const UNIT = 1_000_000;
export const SUPPLY_ATOMS = 1_000_000_000_000_000n; // 10^15: 1,000,000,000 RNG at 6 decimals
const DAY = 86_400_000;
const isPid = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const atomsOf = (rng) => {
  if (!Number.isSafeInteger(Number(rng)) || Number(rng) < 1) throw new Error(`bad RNG amount ${rng}: whole RNG only`);
  return String(BigInt(rng) * BigInt(UNIT));
};

// ---------------------------------------------------------------------------
// Pure builders (tested in test/deployment-config.test.mjs)
// ---------------------------------------------------------------------------

/** Allocations file -> { table: { addr: atoms(BigInt) }, rows, ticker, reserveRng, treasuryRng, validatorRng }.
 * `$DEPLOYER` is the deployer's address; repeated addresses are summed.
 * `distribution` is what the runbook transfers on from the genesis holder
 * (reserve and treasury go under DAO control in the beacon; validatorRng is
 * each launch validator's grant, bonded whole). */
export function loadAllocations(spec, { deployer } = {}) {
  if (!spec || !Array.isArray(spec.allocations) || !spec.allocations.length) throw new Error('allocations[] is required');
  const table = {};
  const rows = [];
  let sum = 0n;
  const byRole = {};
  for (const row of spec.allocations) {
    const address = row.address === '$DEPLOYER' ? deployer : row.address;
    if (!isPid(address)) throw new Error(`allocation ${row.role || '?'}: invalid address ${address}`);
    let atoms;
    if (row.atoms !== undefined) {
      if (!/^[1-9][0-9]*$/.test(String(row.atoms))) throw new Error(`allocation ${row.role}: atoms must be a positive integer`);
      atoms = BigInt(row.atoms);
    } else {
      if (!Number.isSafeInteger(row.rng) || row.rng < 1) throw new Error(`allocation ${row.role}: rng must be a positive whole number`);
      atoms = BigInt(row.rng) * BigInt(UNIT);
    }
    sum += atoms;
    table[address] = (table[address] || 0n) + atoms;
    rows.push({ role: row.role, address, atoms: String(atoms), forward: row.forward });
    if (row.role) byRole[row.role] = (byRole[row.role] || 0n) + atoms;
  }
  if (sum !== SUPPLY_ATOMS) throw new Error(`allocations sum to ${sum} atoms, not exactly ${SUPPLY_ATOMS}`);
  const rngOf = (role) => (byRole[role] ? Number(byRole[role] / BigInt(UNIT)) : 0);
  const dist = spec.distribution || {};
  const whole = (name) => {
    const v = dist[name];
    if (v === undefined) return 0;
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`distribution.${name} must be a whole RNG amount`);
    return v;
  };
  const reserveRng = rngOf('reserve') || whole('reserveRng');
  const treasuryRng = rngOf('treasury') || whole('treasuryRng');
  const validatorRng = whole('validatorRng');
  if (BigInt(reserveRng + treasuryRng) * BigInt(UNIT) > SUPPLY_ATOMS) throw new Error('distribution exceeds the supply');
  return { table, rows, ticker: spec.ticker || 'RNG', reserveRng, treasuryRng, validatorRng };
}

/** The Lua prelude rng-token.lua reads on its first slot. */
export function genesisPrelude({ table, ticker }) {
  const entries = Object.keys(table).sort().map((a) => `  [${JSON.stringify(a)}] = ${table[a]},`);
  return [
    `GenesisAllocations = {`, ...entries, `}`,
    ...(ticker && ticker !== 'RNG' ? [`TokenTicker = ${JSON.stringify(ticker)}`] : []),
  ].join('\n');
}

/** The beacon's hard bounds (anyhonest.lua badParams), checked before sending. */
export function badParams(p) {
  const bad = [];
  const need = (ok, why) => { if (!ok) bad.push(why); };
  for (const [k, v] of Object.entries(p)) need(Number.isSafeInteger(v), `${k} must be an integer`);
  need(p.T >= 134217728 && p.T <= 4294967296, 'T in [2^27, 2^32]');
  need(p.revealWindowMs >= 10000 && p.revealWindowMs <= 600000, 'revealWindowMs in [10s, 600s]');
  need(p.commitWindowMs >= 500 && p.commitWindowMs <= 10000, 'commitWindowMs in [500, 10000]');
  need(p.abandonAfterMs >= p.revealWindowMs && p.abandonAfterMs <= 7 * DAY, 'revealWindowMs <= abandonAfterMs <= 7 d');
  need(p.slash >= 1 && p.slash * 10 <= p.stake && p.stake <= 10000000, '1 <= slash <= stake / 10, stake <= 10^7');
  need(p.rejoinBaseMs >= p.revealWindowMs && p.rejoinCapMs >= p.rejoinBaseMs && p.rejoinCapMs <= 30 * DAY,
    'revealWindowMs <= rejoinBaseMs <= rejoinCapMs <= 30 d');
  need(p.minCommits >= 2 && p.minCommits <= p.maxActive && p.maxActive >= 8 && p.maxActive <= 128,
    '2 <= minCommits <= maxActive, 8 <= maxActive <= 128');
  need(p.maxValidators >= p.maxActive && p.maxValidators <= 1024, 'maxActive <= maxValidators <= 1024');
  need(p.heartbeat === 0 || p.heartbeat === 1, 'heartbeat 0 or 1');
  need(p.roundPrice >= 1 && p.requestPrice >= 1 && p.subscriptionPrice >= 1 && p.crackBounty >= 1, 'prices and bounty >= 1');
  need(p.roundPrice <= 1e6 && p.requestPrice <= 1e6 && p.subscriptionPrice <= 1e6, 'prices <= 1,000,000 RNG');
  need(p.subscriptionRounds >= 1 && p.subscriptionRounds <= 31536000, 'subscriptionRounds in [1, 31536000]');
  need(p.cadenceMs >= 0 && p.cadenceMs <= 60000 && p.targetIntervalMs >= 0 && p.targetIntervalMs <= 600000
    && p.maxInFlight >= 1 && p.maxInFlight <= 8 && p.catchUpMs >= 0, 'rhythm parameters (cadence <= 60 s, interval <= 10 min, maxInFlight <= 8)');
  need(p.crackBounty <= p.slash, 'crackBounty <= slash');
  need(2 * (1 + p.maxInFlight) * (p.slash + p.crackBounty) <= p.stake, 'one incident ((1 + maxInFlight) x (slash + crackBounty)) <= stake / 2');
  need(p.fairWindowMs >= 1, 'fairWindowMs >= 1');
  return bad;
}

/** Data of the deployer's genesis Gov.Configure. */
export function genesisConfig({ beacon, token, params, hTable }) {
  const { predecessor = '', T, ...rest } = params;
  const puzzle = hTable[String(T)];
  if (!puzzle) throw new Error(`deploy/anyhonest-h.json has no h for T=${T}`);
  if (!isPid(beacon) || !isPid(token)) throw new Error('genesis needs the beacon and token ids');
  if (predecessor !== '' && !isPid(predecessor)) throw new Error('predecessor must be a process id or ""');
  const p = { T, ...rest };
  const bad = badParams(p);
  if (bad.length) throw new Error(`params outside the beacon's hard bounds: ${bad.join('; ')}`);
  return { self: beacon, token, unit: UNIT, predecessor, ...p, h: puzzle.h, hProof: puzzle.hProof };
}

/** gov.lua's floor: a DAO money/code action takes effect no sooner than this after it arrives. */
export const EXIT_FLOOR_MS = DAY;
/** gov.lua's RESERVE_FLOOR_MS: Gov.Set-Successor and Gov.Move-Reserve (the 200 M reserve) wait a week. */
export const RESERVE_FLOOR_MS = 7 * DAY;
/** The floor a DAO action waits after it arrives. */
export const floorFor = (action) => (['Gov.Set-Successor', 'Gov.Move-Reserve'].includes(action) ? RESERVE_FLOOR_MS : EXIT_FLOOR_MS);
/** RNG Labs' stake in the DAO at launch, whole RNG (RNG_LABS_STAKE overrides). Labs controls
 * votes only while no coalition stakes more (PERMISSIONLESS.md "Who governs"). */
export const LABS_STAKE_RNG = 50_000_000;

/** The RNG DAO's definition (DAO.md rules; PERMISSIONLESS.md "YapDAO instance"). Voting-Period
 * is 1 day, the floor stake-dao/1 lets a vote go to (it can be raised later, never below 1 day).
 * Quorum-Bps 1000: while Labs holds most of the stake, Labs votes on every proposal (dao-watch;
 * PERMISSIONLESS.md "Who governs the DAO"). */
export function daoRules({ token, ticker = 'RNG' }) {
  return {
    'Dao-Name': ticker.startsWith('TEST-') ? 'TEST-RNG DAO' : 'RNG DAO',
    'Dao-Token': token,
    'Dao-Ticker': ticker,
    'Dao-Denomination': '6',
    'Proposal-Threshold': String(25_000 * UNIT),
    'Proposal-Deposit': String(5_000 * UNIT),
    'Voting-Period': String(DAY),
    'Quorum-Bps': '1000',
    'Pass-Bps': '5000',
    'Veto-Bps': '3334',
    'Unstake-Delay': String(14 * DAY),
    'Max-Active-Proposals': '20',
    'Max-Proposals-Per-Proposer': '1',
  };
}

/** Recorded processes that must share the deployment's one scheduler (D3). */
export function sameScheduler(state, roles) {
  if (!isPid(state.scheduler) && !String(state.scheduler || '').startsWith('DRY')) throw new Error('no scheduler pinned');
  for (const role of roles) {
    const pid = state[role];
    if (!pid) throw new Error(`${role} is not deployed`);
    const rec = state.processes?.[pid];
    if (!rec) throw new Error(`${role} ${pid} has no spawn record`);
    if (rec.scheduler !== state.scheduler) {
      throw new Error(`${role} ${pid} is on scheduler ${rec.scheduler}, not ${state.scheduler}: from-process would not be believed`);
    }
  }
  return true;
}

// YapDAO dao.lua Exec-Tags rules (readAction, EXEC_* caps, EXEC_RESERVED).
const word = (s) => String(s).toLowerCase().replace(/[-_\s]/g, '');
const EXEC_RESERVED = new Set(['target', 'fromprocess', 'from', 'owner', 'signature', 'signatures', 'commitments',
  'committer', 'id', 'anchor', 'data', 'body', 'device', 'path', 'method', 'status', 'scheduler', 'schedulerlocation',
  'process', 'priv', 'type', 'variant', 'dataprotocol', 'pushedfor', 'fromscheduler', 'hashpath', 'slot', 'timestamp',
  'blockheight', 'contenttype', 'contentdigest', 'aotypes', 'aoresult', 'codecdevice', 'bundle',
  'xtransfersequence', 'xreference', 'cast']);
// gov.lua's verbs a DAO proposal may carry (Gov.Renounce-Wallet is the wallet's
// alone; Gov.Upgrade carries code in Data, which a proposal cannot: anyone
// uploads the approved code instead).
const OWNER_TAGS = { 'Gov.Set-Dao': ['Dao'], 'Gov.Approve-Code': ['Code-Root'] };
// Every verb may carry Effective-At; the money/code ones must (MONEY_*), and the DAO may cancel a
// pending one (Gov.Cancel). Gov.Apply is anyone's, never a proposal.
const GOV_TAGS = {
  'Gov.Configure': null, // checked against CONFIGURE_TAGS
  'Gov.Set-Successor': ['Successor'], 'Gov.Move-Reserve': ['Successor'], 'Gov.Treasury-Spend': ['Recipient', 'Quantity'],
  'Gov.Fund-Reserve': ['Quantity'], 'Gov.Remove-Validator': ['Validator'], 'Gov.Pause': [], 'Gov.Resume': [],
  'Gov.Cancel': ['Gov-Id'], ...OWNER_TAGS,
};
// The fast tier's Gov.* (beacon/beacon.lua).
const FAST_GOV_TAGS = {
  'Gov.Configure': ['Signer-Fee', 'Protocol-Fee', 'Abandon-After-Ms', 'Committee', 'Share-Public-Keys', 'Group-Key', 'Threshold', 'Verification'],
  'Gov.Claim-Protocol': ['Recipient'], 'Gov.Pause': [], 'Gov.Resume': [], 'Gov.Cancel': ['Gov-Id'], ...OWNER_TAGS,
};
// Fair play (fair/fair.lua): Fair.Configure by tag.
const FAIR_GOV_TAGS = {
  'Fair.Configure': ['Beacon', 'Token', 'Request-Price', 'Fair-Window-Ms', 'Keep', 'Max-Open', 'Min-Interval-Ms',
    'Max-Games', 'Max-Per-Game'],
  'Gov.Cancel': ['Gov-Id'], ...OWNER_TAGS,
};
// What a proposal must give Effective-At for (the contracts' govClass; a Configure counts by the
// tags it names, which is conservative: a value equal to the current one is harmless there).
const MONEY_VERBS = ['Gov.Set-Successor', 'Gov.Move-Reserve', 'Gov.Treasury-Spend', 'Gov.Fund-Reserve',
  'Gov.Remove-Validator', 'Gov.Set-Dao', 'Gov.Approve-Code', 'Gov.Claim-Protocol'];
// Max-Active, Max-Validators (lower) and Min-Commits (higher) are money one way only: a proposal
// naming them carries Effective-At either way.
const MONEY_TAGS = {
  beacon: ['Stake', 'Slash', 'Commit-Window-Ms', 'Reveal-Window-Ms', 'Crack-Bounty', 'Max-In-Flight', 'Cadence-Ms',
    'Target-Interval-Ms', 'Round-Price', 'Max-Active', 'Max-Validators', 'Min-Commits', 'T', 'H', 'H-Proof'].map(word),
  'fast-tier': ['Committee', 'Share-Public-Keys', 'Group-Key', 'Threshold', 'Verification'].map(word),
  fair: ['Beacon', 'Token'].map(word),
};
const CONFIGURE_TAGS = ['T', 'H', 'H-Proof', 'Commit-Window-Ms', 'Reveal-Window-Ms', 'Abandon-After-Ms', 'Min-Commits',
  'Max-Active', 'Max-Validators', 'Cadence-Ms', 'Target-Interval-Ms', 'Max-In-Flight', 'Catch-Up-Ms', 'Stake', 'Slash',
  'Rejoin-Base-Ms', 'Rejoin-Cap-Ms', 'Heartbeat', 'Round-Price', 'Request-Price', 'Subscription-Price',
  'Subscription-Rounds', 'Crack-Bounty', 'Fair-Window-Ms'].map(word);

/** The Effective-At a proposal made at `now` names: the end of its vote, plus the floor (24 h, or
 * 7 days for the reserve: floorFor), plus `marginMs` for the vote to close and the DAO to deliver it. */
export function effectiveAt({ now = Date.now(), votingPeriodMs = DAY, marginMs = DAY, floorMs = EXIT_FLOOR_MS } = {}) {
  return String(now + votingPeriodMs + floorMs + marginMs);
}

/** Whether a (filled) proposal is a money/code action that must carry Effective-At. */
export function isMoneyProposal(p, target) {
  const tags = p.execTags || {};
  if (MONEY_VERBS.includes(tags.Action)) return true;
  const money = new Set(MONEY_TAGS[target] || []);
  return Object.keys(tags).some((k) => money.has(word(k)));
}

/** Fill a proposal template's $BEACON/$FAST/$DAO/$TOKEN/$FAIR/$KEY placeholders. */
export function fillTemplate(template, vars) {
  const sub = (v) => String(v).replace(/\$([A-Z_]+)/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return {
    ...template,
    execProcess: sub(template.execProcess),
    execTags: Object.fromEntries(Object.entries(template.execTags || {}).map(([k, v]) => [k, sub(v)])),
  };
}

/** Errors a (filled) proposal would hit at the DAO's Propose, or at the beacon
 * (or the fast tier or fair play, when `fast` / `fair` names it and the
 * proposal targets it). */
export function proposalErrors(p, { token, fast, fair, now, votingPeriodMs = DAY } = {}) {
  const errs = [];
  if (typeof p.title !== 'string' || !p.title || p.title.length > 120) errs.push('title must be 1-120 characters');
  if (typeof p.body !== 'string' || p.body.length > 4000) errs.push('body must be at most 4000 characters');
  if (!isPid(p.execProcess)) errs.push('execProcess must be a 43-character process id');
  if (token && p.execProcess === token) errs.push('execProcess cannot be the staked token');
  const tags = p.execTags || {};
  const names = Object.keys(tags);
  if (!names.length) errs.push('execTags names no tags');
  if (names.length > 16) errs.push('execTags has more than 16 tags');
  if (JSON.stringify(tags).length > 2048) errs.push('execTags is longer than 2048 bytes');
  const seen = new Set();
  for (const name of names) {
    const v = tags[name];
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) errs.push(`tag ${name}: letters, digits, - or _ (<= 64)`);
    if (EXEC_RESERVED.has(word(name)) || word(name).startsWith('commitment') || word(name).startsWith('xdao')) errs.push(`tag ${name} is reserved by the DAO`);
    if (seen.has(word(name))) errs.push(`tag ${name} twice`);
    seen.add(word(name));
    if (typeof v !== 'string' || !v || v.length > 512 || /[\x00-\x1f\x7f]/.test(v)) errs.push(`tag ${name}: non-empty string <= 512, no control characters`);
  }
  const action = tags.Action;
  const target = Boolean(fast) && p.execProcess === fast ? 'fast-tier' : Boolean(fair) && p.execProcess === fair ? 'fair' : 'beacon';
  const table = { 'fast-tier': FAST_GOV_TAGS, fair: FAIR_GOV_TAGS, beacon: GOV_TAGS }[target];
  if (!(action in table)) errs.push(`Action ${action} is not a ${target} action the DAO may send`);
  else {
    const allowed = new Set(['action', 'effectiveat', ...(table[action] || CONFIGURE_TAGS).map(word)]);
    for (const name of names) if (!allowed.has(word(name))) errs.push(`${action} does not read tag ${name}`);
    if (action === 'Gov.Configure' && names.length > 15) errs.push('Gov.Configure takes at most 14 parameters');
    const eaName = names.find((n) => word(n) === 'effectiveat');
    const ea = eaName && tags[eaName];
    if (ea !== undefined && !/^\d{1,15}$/.test(ea)) errs.push('Effective-At must be whole milliseconds');
    if (isMoneyProposal(p, target)) {
      if (ea === undefined) errs.push(`${action} moves money or code: it needs Effective-At (>= the vote's end + 24 h)`);
      else if (now !== undefined && /^\d+$/.test(ea) && Number(ea) < now + votingPeriodMs + floorFor(action)) {
        errs.push(`Effective-At ${ea} is before the vote can end plus ${floorFor(action) === DAY ? '24 h' : '7 d'}`
          + ` (${now + votingPeriodMs + floorFor(action)})`);
      }
    }
  }
  return errs;
}

/** A relaunch (`spawn-<role> --replace`): the old process goes to `state.retired`
 * with its owners and audited build, and the role's owner record is cleared, so
 * set-dao / renounce-wallet / dao-handover treat the new process as fresh. The
 * old id stays in `state.processes`, marked retired. Returns the retired entry,
 * or null when nothing was deployed under `role`. */
export function retireRole(state, role, at = new Date().toISOString()) {
  const pid = state[role];
  if (!isPid(pid)) return null;
  const entry = { role, pid, retiredAt: at };
  if (state.owners?.[role]) entry.owners = state.owners[role];
  if (state.expectedCode?.[role]) entry.expectedCode = state.expectedCode[role];
  state.retired = [...(state.retired || []), entry];
  if (state.owners) delete state.owners[role];
  if (state.expectedCode) delete state.expectedCode[role];
  if (state.processes?.[pid]) state.processes[pid] = { ...state.processes[pid], retired: at };
  delete state[role];
  return entry;
}

/** The governed protocols and the key each publishes its owners in (`gov`). */
export const PROTOCOL_ROLES = ['beacon', 'fair', 'fast'];
export const INFO_KEY = { beacon: 'beaconinfo', fair: 'fairinfo', fast: 'beaconinfo' };

/** Why Gov.Set-Dao must not be sent to `role` (empty: go). The DAO must be a
 * live stake-dao/1 process on our token with no admin (a wallet publishes no
 * daoinfo), on the one scheduler; the protocol must be configured on the
 * token and still answer to the wallet. */
export function setDaoErrors({ state, role, info, daoinfo, me }) {
  const errs = [];
  if (!PROTOCOL_ROLES.includes(role)) return [`${role} is not a governed protocol (${PROTOCOL_ROLES.join(', ')})`];
  if (!isPid(state[role])) errs.push(`${role} is not deployed`);
  if (!isPid(state.dao)) errs.push('no DAO recorded: spawn-dao first');
  if (state.dao && state.dao === me) errs.push('the DAO is the deployer wallet');
  try { sameScheduler(state, ['dao', role]); } catch (e) { errs.push(e.message); }
  if (!info) errs.push(`${role} ${state[role]} publishes no ${INFO_KEY[role]}`);
  else {
    if (info.token !== state.token) errs.push(`${role} is not configured on the token yet`);
    if (!info.gov) errs.push(`${role} publishes no gov: not a co-owned build`);
    else if (info.gov.wallet !== true && info.gov.dao !== state.dao) errs.push(`${role} no longer answers to the wallet`);
  }
  if (!daoinfo) errs.push(`DAO ${state.dao} publishes no daoinfo: not a live DAO process (a wallet?)`);
  else {
    if (daoinfo.Standard !== 'stake-dao/1') errs.push(`DAO is ${daoinfo.Standard}, not stake-dao/1`);
    if (daoinfo.Configured !== true || daoinfo.Token !== state.token) errs.push('DAO is not configured on our token');
    if (daoinfo.Admin !== '') errs.push('DAO has an admin');
  }
  return errs;
}

/** The build `role` must be running (recorded at spawn: the spawn module, gov.code "" and
 * version 0; expect-code records an upgrade the DAO installed), or null. */
export const expectedBuild = (state, role) => state.expectedCode?.[role] || null;

/** Why `role` is not running the recorded build (empty: it is). */
export function buildErrors({ state, role, info }) {
  const want = expectedBuild(state, role);
  if (!want) return [`no audited build recorded for ${role} (spawn records it; expect-code after an upgrade)`];
  const gov = info?.gov || {};
  const errs = [];
  if ((gov.code || '') !== want.code || Number(gov.version || 0) !== want.version) {
    errs.push(`${role} runs code "${gov.code || ''}" v${gov.version || 0}, not the recorded build "${want.code}" v${want.version}`
      + (gov.approved && gov.approved === want.code ? ' (a cold restore: resend the installed code, deploy/README.md)' : ''));
  }
  return errs;
}

/** Why Gov.Renounce-Wallet must not be sent to `role` (empty: go): one
 * way, so only once the protocol reads the recorded DAO as its owner, the
 * DAO is a live stake-dao/1 on our token, nothing is queued or approved
 * (the contract refuses those too), and it runs the recorded build. */
export function renounceErrors({ state, role, info, daoinfo }) {
  if (!PROTOCOL_ROLES.includes(role)) return [`${role} is not a governed protocol (${PROTOCOL_ROLES.join(', ')})`];
  if (!info) return [`${role} ${state[role]} publishes no ${INFO_KEY[role]}`];
  if (!info.gov) return [`${role} publishes no gov: not a co-owned build`];
  if (!isPid(state.dao) || info.gov.dao !== state.dao) return [`${role} does not name the DAO ${state.dao}: set-dao ${role} first`];
  if (info.gov.wallet !== true) return [`${role} has no wallet owner left to renounce`];
  const errs = [];
  if (!Array.isArray(info.govPending)) errs.push(`${role} publishes no govPending`);
  else if (info.govPending.length) {
    errs.push(`${role} has ${info.govPending.length} pending action(s) (${info.govPending.map((p) => p.id).join(', ')}): apply or cancel them first`);
  }
  if ((info.gov.approved || '') !== '') errs.push(`${role} has code root ${info.gov.approved} approved: cancel it first (Gov.Cancel Gov-Id=code)`);
  errs.push(...buildErrors({ state, role, info }));
  if (!daoinfo) errs.push(`DAO ${state.dao} publishes no daoinfo: not a live DAO process`);
  else if (daoinfo.Standard !== 'stake-dao/1' || daoinfo.Configured !== true || daoinfo.Token !== state.token
      || daoinfo.Admin !== '') {
    errs.push(`DAO ${state.dao} is not a configured stake-dao/1 on our token with no admin`);
  }
  return errs;
}

/** What `dao-watch` flags: every open proposal (and whether Labs, `me`, has voted on it) and every
 * pending action on the protocols. Each { what, detail }. */
/** The live-rate warning: the beacon's average over RATE_WINDOW_MS below this. */
export const MIN_RATE = 1.8;
export const RATE_WINDOW_MS = 300_000;

/** The `timelockhistory` entry ([round, slot]) closest to `windowMs` of rounds
 *  at `perSec` back from the newest, skipping abandoned rounds. */
export function historyPoint(history, { windowMs = RATE_WINDOW_MS, perSec = 2 } = {}) {
  const rounds = (Array.isArray(history?.rounds) ? history.rounds : []).filter((e) => Array.isArray(e) && e.length === 2);
  if (rounds.length < 2) return null;
  const want = rounds.at(-1)[0] - Math.round((windowMs / 1000) * perSec);
  return rounds.reduce((best, e) => (Math.abs(e[0] - want) < Math.abs(best[0] - want) ? e : best));
}

/** The node keeps only ~5 minutes of computed slots (older reads answer 410),
 *  so the live rate never reads an old slot: callers sample `now/beaconinfo`
 *  ({ round, at }, beacon time) over time and keep their own samples. */
export const RATE_MIN_SPAN_MS = 60_000;
/** `samples` plus `info` ({ round, at }), oldest first, the last `keepMs` only. */
export function addRateSample(samples, info, keepMs = 3 * RATE_WINDOW_MS) {
  const ok = (x) => x && Number.isFinite(Number(x.round)) && Number(x.at) > 0;
  const list = (Array.isArray(samples) ? samples : []).filter(ok).map((x) => ({ round: Number(x.round), at: Number(x.at) }));
  if (ok(info)) list.push({ round: Number(info.round), at: Number(info.at) });
  const newest = Math.max(0, ...list.map((x) => x.at));
  return list.filter((x) => x.at >= newest - keepMs).sort((a, b) => a.at - b.at);
}
/** The sample to measure `now` against: at least `minSpanMs` older, nearest to
 *  `windowMs` back. Null when no sample is old enough yet. */
export function rateBase(samples, now, { windowMs = RATE_WINDOW_MS, minSpanMs = RATE_MIN_SPAN_MS } = {}) {
  const at = Number(now?.at);
  const old = (Array.isArray(samples) ? samples : []).filter((x) => at - x.at >= minSpanMs && x.round <= Number(now.round));
  if (!old.length) return null;
  return old.reduce((best, x) => (Math.abs(at - windowMs - x.at) < Math.abs(at - windowMs - best.at) ? x : best));
}

/** Live rate: rounds per second between two beaconinfo reads ({ round, at },
 *  beacon time), and the p50 of finalizedAt - opened over `recent`. */
export function beaconRate({ then, now, recent }) {
  const ms = Number(now?.at) - Number(then?.at);
  const rate = ms > 0 && Number.isFinite(now?.round - then?.round) ? (now.round - then.round) / (ms / 1000) : null;
  const lat = (Array.isArray(recent) ? recent : []).filter((r) => r.finalizedAt > 0 && r.opened > 0)
    .map((r) => r.finalizedAt - r.opened).sort((a, b) => a - b);
  return { rate, windowMs: ms > 0 ? ms : null, p50LatencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : null };
}

/** The rate checks (verify, status) for beaconRate's result. */
export function rateChecks(r, { minRate = MIN_RATE, commitWindowMs = 5000 } = {}) {
  const known = (x) => x !== null && x !== undefined;
  return [
    { check: `beacon rate >= ${minRate} rounds/s`, ok: known(r?.rate) && r.rate >= minRate,
      detail: known(r?.rate) ? `${r.rate.toFixed(2)} rounds/s over ${Math.round(r.windowMs / 1000)} s` : 'unknown' },
    { check: 'round latency p50 < commitWindowMs/2', ok: known(r?.p50LatencyMs) && r.p50LatencyMs < commitWindowMs / 2,
      detail: `${r?.p50LatencyMs ?? 'unknown'} ms, commitWindowMs ${commitWindowMs}` },
  ];
}

export function watchAlerts({ proposals, stake, infos, rate, minRate = MIN_RATE }) {
  const out = [];
  if (rate && !(rate.rate >= minRate)) {
    out.push({ what: `beacon slow: ${rate.rate === null ? 'rate unknown' : `${rate.rate.toFixed(2)} rounds/s`} (want >= ${minRate})`, detail: rate });
  }
  const votes = stake?.votes || {};
  for (const p of Array.isArray(proposals) ? proposals : []) {
    if (p.status !== 'active') continue;
    out.push({ what: `proposal ${p.id} open${votes[p.id] ? ` (Labs voted ${votes[p.id]})` : ': Labs has NOT voted'}`,
      detail: { title: p.title, endsAt: p.endsAt, action: p.action, yes: p.yes, no: p.no, veto: p.veto, quorum: p.quorum } });
  }
  for (const [role, info] of Object.entries(infos || {})) {
    for (const g of info?.govPending || []) out.push({ what: `${role} pending ${g.id} ${g.verb} (${g.class})`, detail: g });
  }
  return out;
}

/** Why a transfer to the beacon (or the fast tier: role 'fast') would strand
 * (null: go): before genesis it refuses every Credit-Notice. */
export function fundError({ state, beaconinfo, role = 'beacon' }) {
  if (!beaconinfo || !state.token || beaconinfo.token !== state.token) {
    const step = role === 'fast' ? 'genesis-configure-fast' : 'genesis-configure';
    return `${role} ${state[role]} has not run ${step} (beaconinfo.token unset): a transfer now would strand`;
  }
  return null;
}

/** Data of the deployer's genesis Gov.Configure for the fast tier: the
 * existing DKG committee (deploy/committee.json), the v3 token, fees. */
export function fastGenesisConfig({ fast, token, committee, signerFee = 1, protocolFee = 1 }) {
  if (!isPid(fast) || !isPid(token)) throw new Error('fast genesis needs the fast-tier and token ids');
  const { t, groupKey, members, sharePublicKeys } = committee || {};
  const hex96 = (k) => typeof k === 'string' && /^[0-9a-fA-F]{96}$/.test(k);
  if (!Array.isArray(members) || !members.length || !members.every(isPid) || new Set(members).size !== members.length) {
    throw new Error('committee.members must be distinct addresses');
  }
  if (!Number.isSafeInteger(t) || t < 2 || t > members.length) throw new Error('committee.t must be in [2, members]');
  if (!hex96(groupKey)) throw new Error('committee.groupKey must be 96 hex characters');
  if (!Array.isArray(sharePublicKeys) || sharePublicKeys.length !== members.length || !sharePublicKeys.every(hex96)) {
    throw new Error('committee.sharePublicKeys must give one 96-hex key per member');
  }
  return { self: fast, token, unit: UNIT, committee: members, sharePublicKeys, groupKey, threshold: t,
    verification: 'attestations', signerFee, protocolFee };
}

/** Live checks over the published keys; each { check, ok, detail }. */
export function checkV3({ state, tokeninfo, daoinfo, beaconinfo, fairinfo, fastinfo, rate, minRate = MIN_RATE }) {
  const out = [];
  const c = (check, ok, detail = '') => out.push({ check, ok: !!ok, detail });
  if (state.token) {
    c('token sealed', tokeninfo?.Sealed === 'true' || tokeninfo?.Sealed === true, tokeninfo?.Sealed);
    c('token supply 10^15', String(tokeninfo?.TotalSupply) === String(SUPPLY_ATOMS), tokeninfo?.TotalSupply);
    c('token sequenced-v1', tokeninfo?.ProcessTransferProtocol === 'sequenced-v1', tokeninfo?.ProcessTransferProtocol);
  }
  if (state.dao) {
    c('dao configured on RNG', daoinfo?.Configured === true && daoinfo?.Token === state.token, daoinfo?.Token);
    c('dao has no admin', daoinfo?.Admin === '', daoinfo?.Admin);
  }
  if (state.beacon) {
    c('beacon token', beaconinfo?.token === state.token, beaconinfo?.token);
    c('beacon self', beaconinfo?.self === state.beacon, beaconinfo?.self);
    if (state.predecessor !== undefined) c('beacon predecessor', (beaconinfo?.predecessor || '') === state.predecessor, beaconinfo?.predecessor);
    c('beacon health ok', beaconinfo?.health?.status === 'ok', JSON.stringify(beaconinfo?.health));
    c('beacon reserve funded', BigInt(beaconinfo?.foundationReserveAtoms || 0) > 0n, beaconinfo?.foundationReserveAtoms);
    if (rate) out.push(...rateChecks(rate, { minRate, commitWindowMs: Number(beaconinfo?.params?.commitWindowMs) || 5000 }));
  }
  if (state.fast) {
    c('fast token', fastinfo?.token === state.token, fastinfo?.token);
    c('fast self', fastinfo?.self === state.fast, fastinfo?.self);
    c('fast on demand', fastinfo?.tier === 'fast' && fastinfo?.nextRoundAt === 0, fastinfo?.mode);
    c('fast committee', Array.isArray(fastinfo?.committee) && fastinfo.committee.length >= fastinfo.threshold
      && fastinfo.threshold >= 2, `${fastinfo?.threshold}/${fastinfo?.committee?.length}`);
  }
  if (state.fair) {
    c('fair bound to beacon', fairinfo?.beacon === state.beacon, fairinfo?.beacon);
    c('fair paid in RNG', fairinfo?.token === state.token && Number(fairinfo?.requestPriceAtoms) > 0, fairinfo?.token);
  }
  // Owners: what set-dao / renounce-wallet recorded must be what each protocol publishes.
  for (const [role, info] of [['beacon', beaconinfo], ['fair', fairinfo], ['fast', fastinfo]]) {
    const want = state[role] && state.owners?.[role];
    if (!want) continue;
    if (want.dao) c(`${role} owned by the DAO`, info?.gov?.dao === state.dao, info?.gov?.dao);
    if (want.walletRenounced) c(`${role} wallet renounced`, info?.gov?.wallet === false, info?.gov?.wallet);
  }
  // Code: each protocol runs the build recorded for it (a cold restore runs the spawn module).
  for (const [role, info] of [['beacon', beaconinfo], ['fair', fairinfo], ['fast', fastinfo]]) {
    if (!state[role] || !expectedBuild(state, role)) continue;
    const errs = buildErrors({ state, role, info });
    c(`${role} runs the recorded build`, errs.length === 0, errs.join('; ') || info?.gov?.code);
  }
  try { sameScheduler(state, ['token', 'dao', 'beacon', 'fair', 'fast'].filter((r) => state[r])); c('one scheduler', true, state.scheduler); }
  catch (e) { c('one scheduler', false, e.message); }
  return out;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const json = () => [
  read('protocol/vendor/json.lua'),
  'local jsonx = (function()', read('protocol/vendor/jsonenc.lua'), 'end)()',
  'local encode, jsonObject = jsonx.encode, jsonx.object',
];
export const tokenSource = (prelude) => [prelude, ...json(), read('protocol/token/rng-token.lua')].join('\n');
// Every governed protocol carries paralith-mono's gov.lua (vendored, checked
// against PARALITH_MONO by the deploy tests) and its sha256.lua.
const govSource = () => [read('protocol/vendor/sha256.lua'), read('protocol/vendor/gov.lua')];
const anyHonestSource = () => [...json(), 'rng = (function()', read('lib/rng.lua'), 'end)()', ...govSource(),
  read('protocol/beacon/anyhonest.lua')].join('\n');
// lua-patch@1.0 (paralith-mono's lua53b.lua adapter): only changed keys are
// published and the VM keeps state between messages. The adapter's compute
// calls the beacon's, so the beacon's final full collect moves out to it; the
// bootstrap gives the owner and scheduler facts lua@5.3a reads from `base.process`.
const anyHonestPatchSource = (owner, scheduler) => {
  const src = anyHonestSource();
  const collect = 'collectgarbage("collect")';
  const at = src.lastIndexOf(collect);
  if (at === -1) throw new Error('beacon has no final full collect');
  const q = JSON.stringify;
  return [
    src.slice(0, at) + src.slice(at + collect.length),
    `Lua53bBootstrapBase = { process = { commitments = { owner = { committer = ${q(owner)}, type = "rsa-pss-sha512" } },`
      + ` ["scheduler-location"] = ${q(scheduler)} }, ["scheduler-location"] = ${q(scheduler)} }`,
    'Lua53bKeepaliveKey = "timelockrev"',
    'Lua53bGcStep = 5000',
    'Lua53bPatchMode = true',
    read('protocol/vendor/lua53b.lua'),
  ].join('\n');
};
const fairSource = () => [
  read('protocol/vendor/json.lua'),
  'local jsonx = (function()', read('protocol/vendor/jsonenc.lua'), 'end)()',
  'encode, jsonObject = jsonx.encode, jsonx.object',
  'json = require(".json")',
  'rng = (function()', read('lib/rng.lua'), 'end)()',
  'fair = (function()', read('lib/fair.lua'), 'end)()',
  ...govSource(),
  read('protocol/fair/fair.lua'),
].join('\n');
// The fast tier: on-demand threshold BLS (lua@5.3a, whole state per message).
const fastSource = () => [...json(), 'rng = (function()', read('lib/rng.lua'), 'end)()', ...govSource(),
  read('protocol/beacon/beacon.lua')].join('\n');
/** gov.lua's code root: the code in parts of at most PART_MAX bytes; the
 *  manifest is each part's sha256 hex joined by newlines; root = sha256(manifest). */
export const GOV_PART_MAX = 16 * 1024;
export function codeRoot(code) {
  const buf = Buffer.from(code, 'utf8');
  const parts = [];
  // Parts end on a character boundary (each part is sent as text).
  for (let i = 0; i < buf.length;) {
    let end = Math.min(i + GOV_PART_MAX, buf.length);
    while (end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
    parts.push(buf.subarray(i, end));
    i = end;
  }
  const manifest = parts.map((p) => createHash('sha256').update(p).digest('hex')).join('\n');
  return { root: sha256(manifest), manifest, parts };
}
/** The full bundle an upgrade installs on a role (the beacon's wrapped for lua-patch@1.0). */
export const upgradeSource = (role, owner, scheduler) => role === 'beacon' ? anyHonestPatchSource(owner, scheduler)
  : role === 'fast' ? fastSource() : fairSource();

/** The bundle each protocol role is spawned with (lua@5.3a; the beacon's lua-patch@1.0 wraps its own). */
export const protocolSources = { anyHonest: anyHonestSource, fair: fairSource, fast: fastSource };
const subscriptionConsumerSource = (beacon, id) => [...json(), read('protocol/test/subscription-consumer.lua')]
  .join('\n').replaceAll('__BEACON__', beacon).replaceAll('__SUBSCRIPTION_ID__', id);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const DRY = argv.includes('--dry-run') || process.env.RNG_DRY_RUN === '1';
  const args = argv.filter((a) => a !== '--dry-run');
  const [cmd, ...rest] = args;
  const flag = (name) => rest.includes(name);
  const pos = rest.filter((a) => !a.startsWith('--'));
  const legacy = cmd?.startsWith('legacy-');
  const hb = DRY ? null : await import('../validator/vendor/hbclient.mjs');

  const NODE = process.env.HB_NODE;
  if (!NODE && !DRY) throw new Error('HB_NODE is required');
  let jwk = null;
  if (process.env.HB_WALLET) jwk = JSON.parse(fs.readFileSync(process.env.HB_WALLET, 'utf8'));
  else if (!DRY) throw new Error('HB_WALLET is required');
  const me = jwk ? (hb || await import('../validator/vendor/hbclient.mjs')).jwkToAddress(jwk) : process.env.RNG_DEPLOYER;
  if (!isPid(me)) throw new Error('set HB_WALLET (or RNG_DEPLOYER in --dry-run)');

  const STATE = legacy
    ? path.resolve(process.env.RNG_LEGACY_STATE || path.join(HERE, 'native-testnet.json'))
    : path.resolve(process.env.RNG_STATE || path.join(HERE, 'v3-testnet.json'));
  const state = cmd === 'plan' || !fs.existsSync(STATE) ? {} : JSON.parse(fs.readFileSync(STATE, 'utf8'));
  state.processes ||= {};
  const save = () => {
    if (DRY || legacy) return;
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  };
  const log = (o) => console.log(JSON.stringify(DRY ? { dryRun: true, ...o } : o));
  const placeholder = (role) => `DRY${role}`.replace(/[^A-Za-z0-9]/g, '').padEnd(43, '_').slice(0, 43);

  async function pinScheduler() {
    const env = process.env.RNG_SCHEDULER;
    const actual = DRY ? (env || placeholder('scheduler')) : await hb.nodeAddress(NODE);
    if (env && env !== actual) throw new Error(`RNG_SCHEDULER ${env} is not this node's address ${actual}`);
    if (state.scheduler && state.scheduler !== actual) throw new Error(`this deployment is pinned to scheduler ${state.scheduler}, the node is ${actual}`);
    state.scheduler = actual;
    return actual;
  }

  async function spawn(role, { name, lua, executionDevice = 'lua@5.3a', extra = {} }) {
    const scheduler = await pinScheduler();
    const rec = { role, name, executionDevice, scheduler, sourceBytes: Buffer.byteLength(lua), sourceSha256: sha256(lua) };
    let pid;
    // Only spawn-* --replace gets here with the role deployed: retire the old one.
    if (isPid(state[role])) {
      const old = DRY ? { role, pid: state[role] } : retireRole(state, role);
      log({ op: 'retire', ...old });
    }
    if (DRY) {
      pid = placeholder(role);
      log({ op: 'spawn', pid, ...rec, ...extra });
    } else {
      pid = await hb.spawnProcess({ node: NODE, jwk, lua, scheduler, executionDevice, name });
      log({ op: 'spawn', pid, ...rec });
    }
    state.processes[pid] = { role, scheduler, executionDevice, sourceSha256: rec.sourceSha256, at: new Date().toISOString() };
    state[role] = pid;
    // The audited build: the spawn module (gov.code "" v0 until an upgrade installs).
    if (PROTOCOL_ROLES.includes(role)) {
      state.expectedCode = { ...state.expectedCode, [role]: { code: '', version: 0, sourceSha256: rec.sourceSha256 } };
    }
    save();
    return pid;
  }

  async function send(pid, action, { tags = {}, data } = {}) {
    if (!isPid(pid)) throw new Error(`${action}: no target process`);
    if (DRY) {
      log({ op: 'send', target: pid, action, tags, ...(data !== undefined ? { data: JSON.parse(data) } : {}) });
      return { slot: null, output: '{"dryRun":true}' };
    }
    const { slot } = await hb.sendMessage({ node: NODE, jwk, process: pid, action, tags, data });
    await hb.awaitComputedSlot({ node: NODE, process: pid, slot });
    const out = await hb.readState({ node: NODE, process: pid, path: `compute&slot=${slot}/results/output/data` });
    await hb.pendingPushes({ node: NODE, process: pid });
    log({ op: 'send', target: pid, action, tags, slot, output: out.value });
    return { slot, output: out.value };
  }

  async function key(pid, k) {
    if (DRY || !isPid(pid)) return null;
    const r = await hb.readState({ node: NODE, process: pid, path: `now/${k}` });
    if (r.status !== 200 || /^\s*</.test(r.value || '')) return null;
    try { return JSON.parse(r.value); } catch { return null; }
  }

  // RNG_MIN_RATE: rounds/s below which verify fails and watch alerts (default MIN_RATE).
  const minRate = () => Number(process.env.RNG_MIN_RATE || MIN_RATE);
  /** The beacon's average over the last ~5 minutes, from `now/beaconinfo`
   *  samples only: the node does not keep old slots (410). Samples persist in
   *  <state>.rate-samples.json, so a watch from cron measures against its last
   *  run; with no sample at least RNG_RATE_SAMPLE_MS (default 60 s) old, it
   *  reads once more after that long. A dry run reads nothing: null. */
  async function liveRate() {
    if (DRY || !isPid(state.beacon)) return null;
    const file = STATE.replace(/\.json$/, '') + '.rate-samples.json';
    let samples = [];
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.beacon === state.beacon) samples = saved.samples || [];
    } catch { samples = []; }
    const spanMs = Number(process.env.RNG_RATE_SAMPLE_MS ?? RATE_MIN_SPAN_MS);
    let [now, recent] = await Promise.all([key(state.beacon, 'beaconinfo'), key(state.beacon, 'beaconrecent')]);
    samples = addRateSample(samples, now);
    let then = rateBase(samples, now, { minSpanMs: spanMs });
    if (!then && now && spanMs > 0) {
      await new Promise((r) => setTimeout(r, spanMs));
      [now, recent] = await Promise.all([key(state.beacon, 'beaconinfo'), key(state.beacon, 'beaconrecent')]);
      samples = addRateSample(samples, now);
      then = rateBase(samples, now, { minSpanMs: 1 });
    }
    try { fs.writeFileSync(file, JSON.stringify({ beacon: state.beacon, samples }) + '\n'); } catch { /* best effort */ }
    return beaconRate({ then, now, recent });
  }

  const transfer = (recipient, rng, extraTags = {}) => {
    if (!state.token) throw new Error('spawn-token first');
    return send(state.token, 'Transfer', { tags: { Recipient: recipient, Quantity: atomsOf(rng), ...extraTags } });
  };
  // Every fund-* is refused until the beacon has its token (genesis-configure).
  const fundBeacon = async (rng, tags, role = 'beacon') => {
    if (!DRY) {
      const err = fundError({ state, beaconinfo: await key(state[role], 'beaconinfo'), role });
      if (err) throw new Error(err);
    }
    return transfer(state[role], rng, tags);
  };
  const readJson = (file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const loadParams = (file) => readJson(file || path.join(HERE, 'v3-params.json'));

  const dryOwners = {}; // dry run: protocols set-dao named in this run
  const v3 = {
    async 'spawn-token'(file) {
      if (state.token && !flag('--replace')) throw new Error(`token already deployed (${state.token})`);
      const alloc = loadAllocations(readJson(file || path.join(HERE, 'v3-genesis.json')), { deployer: me });
      const prelude = genesisPrelude(alloc);
      state.deployer = me;
      state.tokenTicker = alloc.ticker;
      state.genesis = { rows: alloc.rows, reserveRng: alloc.reserveRng, treasuryRng: alloc.treasuryRng,
        validatorRng: alloc.validatorRng };
      const pid = await spawn('token', { name: alloc.ticker, lua: tokenSource(prelude), extra: { prelude } });
      await send(pid, 'Info');
      return alloc;
    },

    async 'spawn-dao'() {
      if (state.dao && !flag('--replace')) throw new Error(`DAO already deployed (${state.dao})`);
      sameScheduler(state, ['token']);
      const rules = daoRules({ token: state.token, ticker: state.tokenTicker || 'RNG' });
      const definition = Object.fromEntries(Object.entries(rules).map(([k, v]) => [k.toLowerCase(), v]));
      const device = flag('--lua53b') ? 'lua-patch@1.0' : 'lua@5.3a';
      // deploy-dao.mjs semantics, our rules: the module comes from paralith-mono.
      const PM = path.resolve(process.env.PARALITH_MONO || path.join(ROOT, '..', 'paralith-mono'));
      const imp = (p) => import(pathToFileURL(path.join(PM, p)).href);
      if (DRY) {
        const pid = placeholder('dao');
        // With PARALITH_MONO set, a dry run builds the module too: it proves the
        // DAO bundles from that tree, and names the bytes a live run would spawn.
        let module = null;
        if (process.env.PARALITH_MONO) {
          const { daoModuleSources, dao53bModuleSources } = await imp('backend/native/contracts-53b-bundle.mjs');
          const lua = device === 'lua-patch@1.0'
            ? dao53bModuleSources({ owner: placeholder('spawner'), scheduler: state.scheduler, definition })
            : daoModuleSources();
          module = { from: PM, sourceBytes: Buffer.byteLength(lua), sourceSha256: sha256(lua) };
        }
        log({ op: 'spawn', pid, role: 'dao', standard: 'stake-dao/1', executionDevice: device, scheduler: state.scheduler,
          vanityPrefix: 'yap', definition, ...(module ? { module } : {}) });
        state.processes[pid] = { role: 'dao', scheduler: state.scheduler, executionDevice: device };
        state.dao = pid;
        return pid;
      }
      const { daoModuleSources, dao53bModuleSources } = await imp('backend/native/contracts-53b-bundle.mjs');
      const { spawnVanity, throwawayKey } = await imp('packages/rune-ao/src/spawn/node.mjs');
      const ti = await key(state.token, 'tokeninfo');
      if (ti?.ProcessTransferProtocol !== 'sequenced-v1') throw new Error(`token ${state.token} does not publish sequenced-v1`);
      const scheduler = await pinScheduler();
      const spawner = throwawayKey(); // signs the definition and confers nothing
      const lua = device === 'lua-patch@1.0'
        ? dao53bModuleSources({ owner: hb.jwkToAddress(spawner), scheduler, definition })
        : daoModuleSources();
      const { id } = await spawnVanity({ node: hb.transportNode(NODE), jwk: spawner, lua, prefix: 'yap', ignoreCase: true,
        executionDevice: device, scheduler, tags: { name: rules['Dao-Name'], ...definition } });
      state.processes[id] = { role: 'dao', scheduler, executionDevice: device, sourceSha256: sha256(lua), at: new Date().toISOString() };
      state.dao = id;
      state.daoRules = rules;
      save();
      let info = null;
      for (let i = 0; i < 60 && !info; i++) {
        info = await key(id, 'daoinfo');
        if (!info) await new Promise((r) => setTimeout(r, 1000));
      }
      if (!info || info.Configured !== true || info.Token !== state.token || info.Admin !== ''
          || info.ProposalThreshold !== rules['Proposal-Threshold']) {
        throw new Error(`DAO ${id} is not configured for RNG: ${JSON.stringify(info)}`);
      }
      log({ op: 'dao', dao: id, standard: info.Standard, name: info.Name });
      return id;
    },

    async 'spawn-beacon'() {
      if (state.beacon && !flag('--replace')) throw new Error(`beacon already deployed (${state.beacon})`);
      const lua53a = flag('--lua53a');
      const scheduler = await pinScheduler();
      const pid = await spawn('beacon', { name: 'RNG-Any-Honest-Beacon-v3',
        executionDevice: lua53a ? 'lua@5.3a' : 'lua-patch@1.0',
        lua: lua53a ? anyHonestSource() : anyHonestPatchSource(me, scheduler) });
      await send(pid, 'Get-Info');
      return pid;
    },

    async 'genesis-configure'(file) {
      sameScheduler(state, ['token', 'beacon']);
      const params = loadParams(file);
      const data = genesisConfig({ beacon: state.beacon, token: state.token, params,
        hTable: JSON.parse(read('deploy/anyhonest-h.json')) });
      state.predecessor = data.predecessor;
      save();
      return send(state.beacon, 'Gov.Configure', { data: JSON.stringify(data) });
    },

    'fund-reserve': async (rng) => fundBeacon(rng ?? state.genesis?.reserveRng, { 'X-Foundation': 'true' }),
    'fund-treasury': async (rng) => fundBeacon(rng ?? state.genesis?.treasuryRng, { 'X-Treasury': 'true' }),
    fund: async (rng, forWho) => fundBeacon(rng, { 'X-For': forWho || me }),
    grant: (address, rng) => {
      if (!isPid(address)) throw new Error('grant <address> <rng>');
      return transfer(address, rng);
    },

    async 'bond-for'(rng, ...targets) {
      const list = targets.length === 1 && targets[0].endsWith('.json') ? readJson(targets[0]) : targets;
      if (!list.length || !list.every(isPid)) throw new Error('bond-for <rng> <address...|validators.json>');
      for (const address of list) await transfer(state.beacon, rng, { 'X-For': address, 'X-Bond': 'true' });
    },

    async 'spawn-fair'() {
      if (state.fair && !flag('--replace')) throw new Error(`fair already deployed (${state.fair})`);
      const pid = await spawn('fair', { name: 'RNG-Fair-Play', lua: fairSource() });
      await send(pid, 'Get-Info');
      return pid;
    },
    async 'configure-fair'(windowMs) {
      sameScheduler(state, ['beacon', 'fair']);
      // requestPrice must equal the beacon's: a governance change of it is
      // followed by configure-fair again.
      const d = { beacon: state.beacon, token: state.token, requestPrice: loadParams().requestPrice,
        fairWindowMs: Number(windowMs || 60000), keep: 64, maxOpen: 10000 };
      return send(state.fair, 'Fair.Configure', { data: JSON.stringify(d) });
    },
    // The float the fair process requests from; >= 2 requests, since the next
    // batch may go out before the last top-up lands.
    'fund-fair': async (rng) => fundBeacon(rng, { 'X-For': state.fair }),
    // Any game may play: it prepays its own draws here (and Fair.Withdraws the rest).
    async 'fund-game'(rng, game) {
      if (!isPid(game) || !isPid(state.fair)) throw new Error('fund-game <rng> <game> (after spawn-fair)');
      if (!DRY) {
        const info = await key(state.fair, 'fairinfo');
        if (info?.token !== state.token) throw new Error('configure-fair first: the fair process refuses credits until its token is set');
      }
      return transfer(state.fair, rng, { 'X-Fair-Game': game });
    },

    async gov(action, ...kv) {
      if (!/^Gov\.[A-Za-z-]+$/.test(action || '')) throw new Error('gov <Gov.Action> [Tag=Value ...]');
      if (/^Gov\.(Set-Dao|Renounce-Wallet)$/.test(action)) throw new Error('use `set-dao` / `renounce-wallet`');
      const tags = Object.fromEntries(kv.map((a) => a.split(/=(.*)/s).slice(0, 2)));
      return send(state.beacon, action, { tags });
    },
    'resend-ack': () => send(state.beacon, 'Resend-Successor-Ack'),

    // The DAO becomes an owner beside the wallet, on every named protocol
    // (default: every deployed one). Read back before it is recorded.
    async 'set-dao'(...roles) {
      const list = roles.length ? roles : PROTOCOL_ROLES.filter((r) => state[r]);
      if (!list.length) throw new Error('set-dao [beacon|fair|fast ...]: nothing deployed');
      for (const role of list) {
        if (!DRY) {
          const [info, daoinfo] = await Promise.all([key(state[role], INFO_KEY[role]), key(state.dao, 'daoinfo')]);
          const errs = setDaoErrors({ state, role, info, daoinfo, me });
          if (errs.length) throw new Error(`set-dao ${role} refused: ${errs.join('; ')}`);
        } else {
          const errs = setDaoErrors({ state, role, info: { token: state.token, gov: { dao: '', wallet: true } },
            daoinfo: { Standard: 'stake-dao/1', Configured: true, Token: state.token, Admin: '' }, me });
          if (errs.length) throw new Error(`set-dao ${role} refused: ${errs.join('; ')}`);
        }
        const r = await send(state[role], 'Gov.Set-Dao', { tags: { Dao: state.dao } });
        if (!DRY) {
          const back = (await key(state[role], INFO_KEY[role]))?.gov;
          if (back?.dao !== state.dao) throw new Error(`set-dao ${role}: reads back ${JSON.stringify(back)}; reply ${r.output}`);
        }
        // A dry run records nothing, except that dao-handover may renounce right after it.
        if (DRY) dryOwners[role] = true;
        else state.owners = { ...state.owners, [role]: { ...state.owners?.[role], dao: state.dao } };
        save();
      }
    },
    // One way: after it only the DAO governs that protocol.
    async 'renounce-wallet'(...roles) {
      if (!roles.length) throw new Error('renounce-wallet <beacon|fair|fast ...> --confirm');
      if (!flag('--confirm') && !DRY) throw new Error('Gov.Renounce-Wallet is one way: add --confirm');
      for (const role of roles) {
        if (!DRY) {
          const [info, daoinfo] = await Promise.all([key(state[role], INFO_KEY[role]), key(state.dao, 'daoinfo')]);
          const errs = renounceErrors({ state, role, info, daoinfo });
          if (errs.length) throw new Error(`renounce-wallet ${role} refused: ${errs.join('; ')}`);
        } else if ((state.owners?.[role]?.dao !== state.dao && !dryOwners[role]) || !PROTOCOL_ROLES.includes(role)) {
          throw new Error(`renounce-wallet ${role} refused: set-dao ${role} first`);
        }
        const r = await send(state[role], 'Gov.Renounce-Wallet');
        if (!DRY) {
          const back = (await key(state[role], INFO_KEY[role]))?.gov;
          if (back?.wallet !== false) throw new Error(`renounce-wallet ${role}: reads back ${JSON.stringify(back)}; reply ${r.output}`);
        }
        state.owners = { ...state.owners, [role]: { ...state.owners?.[role], walletRenounced: true } };
        save();
      }
    },

    // Launch: the DAO becomes the only owner of each protocol in one step, and the wallet's powers
    // end. Reads back that every protocol names the DAO and has no wallet owner left.
    async 'dao-handover'(...roles) {
      if (!flag('--confirm') && !DRY) throw new Error('dao-handover renounces the wallet for good: add --confirm');
      const list = roles.length ? roles : PROTOCOL_ROLES.filter((r) => state[r]);
      await v3['set-dao'](...list);
      await v3['renounce-wallet'](...list);
      for (const role of list) {
        const back = DRY ? { dao: state.dao, wallet: false } : (await key(state[role], INFO_KEY[role]))?.gov;
        if (back?.dao !== state.dao || back?.wallet !== false) {
          throw new Error(`dao-handover ${role}: owners read back ${JSON.stringify(back)}`);
        }
        log({ op: 'check', role, owners: { dao: back.dao, wallet: back.wallet } });
      }
    },
    async 'gov-apply'(role, id) {
      if (!PROTOCOL_ROLES.includes(role) || !id) throw new Error('gov-apply <beacon|fair|fast> <Gov-Id>');
      return send(state[role], 'Gov.Apply', { tags: { 'Gov-Id': String(id) } });
    },
    // Labs must watch and vote on every proposal (PERMISSIONLESS.md "Who governs the DAO"):
    // run this at least once per voting period (1 day), e.g. from cron. It also
    // flags a slow beacon (5-minute average under RNG_MIN_RATE, default 1.8/s).
    async watch() {
      const roles = PROTOCOL_ROLES.filter((r) => state[r]);
      const [proposals, stake, rate, ...infos] = await Promise.all([key(state.dao, 'proposals'),
        key(state.dao, `stake-${state.deployer || me}`), liveRate(), ...roles.map((r) => key(state[r], INFO_KEY[r]))]);
      const alerts = watchAlerts({ proposals, stake, rate, minRate: minRate(),
        infos: Object.fromEntries(roles.map((r, i) => [r, infos[i]])) });
      for (const a of alerts) log({ op: 'watch', ...a });
      if (!DRY && (alerts.length || !proposals)) process.exitCode = 1;
      return alerts;
    },
    'dao-watch': () => v3.watch(),
    // code-root <role>: the root of this checkout's bundle for <role>, for
    // 010-approve-code.json (CODE_ROOT). --send uploads it (Gov.Upgrade, the
    // manifest then each part; anyone may), which installs once the DAO's
    // approval is due. Then expect-code <role> <root> <version>.
    async 'code-root'(role) {
      if (!PROTOCOL_ROLES.includes(role)) throw new Error('code-root <beacon|fair|fast> [--send]');
      const scheduler = state.scheduler || process.env.RNG_SCHEDULER;
      const owner = state.deployer || me;
      const code = upgradeSource(role, owner, scheduler);
      const { root, manifest, parts } = codeRoot(code);
      log({ op: 'code-root', role, root, bytes: Buffer.byteLength(code), parts: parts.length, sourceSha256: sha256(code) });
      if (!flag('--send')) return root;
      await send(state[role], 'Gov.Upgrade', { tags: { Part: '0' }, data: manifest });
      for (let i = 0; i < parts.length; i++) {
        await send(state[role], 'Gov.Upgrade', { tags: { Part: String(i + 1) }, data: parts[i].toString('utf8') });
      }
      return root;
    },
    async 'expect-code'(role, root, version) {
      if (!PROTOCOL_ROLES.includes(role) || !/^[0-9a-f]{64}$/.test(root || '') || !Number.isSafeInteger(Number(version))) {
        throw new Error('expect-code <beacon|fair|fast> <64-hex root> <version>');
      }
      state.expectedCode = { ...state.expectedCode, [role]: { code: root, version: Number(version) } };
      save();
      log({ op: 'expect-code', role, code: root, version: Number(version) });
    },

    // Fast tier: on-demand threshold BLS, paid per request; no heartbeat.
    async 'spawn-fast'() {
      if (state.fast && !flag('--replace')) throw new Error(`fast tier already deployed (${state.fast})`);
      const pid = await spawn('fast', { name: 'RNG-Fast-Threshold', lua: fastSource() });
      await send(pid, 'Get-Info');
      return pid;
    },
    async 'genesis-configure-fast'(file) {
      sameScheduler(state, ['token', 'fast']);
      const committee = readJson(file || path.join(HERE, 'committee.json'));
      const data = fastGenesisConfig({ fast: state.fast, token: state.token, committee });
      return send(state.fast, 'Gov.Configure', { data: JSON.stringify(data) });
    },
    'fund-fast': async (rng, forWho) => fundBeacon(rng, { 'X-For': forWho || me }, 'fast'),
    async 'gov-fast'(action, ...kv) {
      if (!/^Gov\.[A-Za-z-]+$/.test(action || '')) throw new Error('gov-fast <Gov.Action> [Tag=Value ...]');
      if (/^Gov\.(Set-Dao|Renounce-Wallet)$/.test(action)) throw new Error('use `set-dao fast` / `renounce-wallet fast`');
      const tags = Object.fromEntries(kv.map((a) => a.split(/=(.*)/s).slice(0, 2)));
      return send(state.fast, action, { tags });
    },

    // Staking is a plain Transfer to the DAO. Default: RNG Labs' launch stake.
    'dao-stake': (rng) => transfer(state.dao, rng ?? (process.env.RNG_LABS_STAKE || LABS_STAKE_RNG)),
    async 'dao-propose'(file, ...kv) {
      const now = Date.now();
      const votingPeriodMs = Number(state.daoRules?.['Voting-Period'] || DAY);
      const vars = { BEACON: state.beacon, FAST: state.fast, DAO: state.dao, TOKEN: state.token, FAIR: state.fair,
        EFFECTIVE_AT: effectiveAt({ now, votingPeriodMs }),
        ...Object.fromEntries(kv.map((a) => a.split(/=(.*)/s).slice(0, 2))) };
      const template = readJson(file);
      if (!kv.some((a) => a.startsWith('EFFECTIVE_AT='))) {
        vars.EFFECTIVE_AT = effectiveAt({ now, votingPeriodMs, floorMs: floorFor(template.execTags?.Action) });
      }
      const p = fillTemplate(template, vars);
      const errs = proposalErrors(p, { token: state.token, fast: state.fast, fair: state.fair, now, votingPeriodMs });
      if (errs.length) throw new Error(`proposal refused: ${errs.join('; ')}`);
      return send(state.dao, 'Propose', { tags: { Title: p.title, Body: p.body,
        'Exec-Process': p.execProcess, 'Exec-Tags': JSON.stringify(p.execTags) } });
    },
    'dao-vote': (id, side) => {
      if (!id || !['Yes', 'No', 'NoWithVeto', 'Abstain'].includes(side)) throw new Error('dao-vote <id> <Yes|No|NoWithVeto|Abstain>');
      return send(state.dao, 'Vote', { tags: { Proposal: String(id), Side: side } });
    },

    async status() {
      const [tokeninfo, daoinfo, beaconinfo, fairinfo, fastinfo, rate] = await Promise.all([
        key(state.token, 'tokeninfo'), key(state.dao, 'daoinfo'), key(state.beacon, 'beaconinfo'), key(state.fair, 'fairinfo'),
        key(state.fast, 'beaconinfo'), liveRate()]);
      const checks = checkV3({ state, tokeninfo, daoinfo, beaconinfo, fairinfo, fastinfo, rate, minRate: minRate() });
      console.log(JSON.stringify({ token: state.token, dao: state.dao, beacon: state.beacon, fair: state.fair, fast: state.fast,
        scheduler: state.scheduler, mode: beaconinfo?.mode, round: beaconinfo?.round, health: beaconinfo?.health, rate,
        registered: beaconinfo?.registered, gov: { beacon: beaconinfo?.gov, fair: fairinfo?.gov, fast: fastinfo?.gov },
        fastRound: fastinfo?.round, checks }, null, 1));
      return checks;
    },
    async verify() {
      const checks = await v3.status();
      const failed = checks.filter((c) => !c.ok);
      if (failed.length && !DRY) { process.exitCode = 1; console.error(`FAILED: ${failed.map((c) => c.check).join(', ')}`); }
    },

    async 'test-subscription'() {
      if (DRY) throw new Error('test-subscription is live only');
      const id = `acceptance-${Date.now()}`;
      const consumer = await spawn('subscriptionConsumer', { name: 'RNG-Subscription-Acceptance',
        lua: subscriptionConsumerSource(state.beacon, id) });
      await transfer(state.beacon, 1, { 'X-For': consumer });
      await send(consumer, 'Start');
      let receipt = null;
      for (let i = 0; i < 30 && !receipt; i++) {
        const r = await key(consumer, 'subscriptionstate');
        if (Number(r?.receipts) > 0) receipt = r;
        else await new Promise((res) => setTimeout(res, 1000));
      }
      if (!receipt) throw new Error('subscription did not deliver within 30 seconds');
      const round = await key(state.beacon, `beaconround-${receipt.lastRound % 8}`);
      if (!round || round.round !== receipt.lastRound) throw new Error(`round ${receipt.lastRound} is not retained`);
      const expected = sha256(`hyperbeam/rng/subscription/v1|${round.value}|${id}|${receipt.lastRound}`);
      if (receipt.lastValue !== expected) throw new Error('subscription value failed independent verification');
      log({ op: 'subscription', consumer, id, round: receipt.lastRound, verified: true });
    },

    async smoke() {
      if (DRY) throw new Error('smoke is live only');
      const { main: smoke } = await import('./smoke.mjs');
      await smoke({ args: rest, node: NODE, jwk, state });
    },

    async plan(allocFile, paramsFile) {
      if (!DRY) throw new Error('plan is --dry-run only');
      await v3['spawn-token'](allocFile);
      await v3['spawn-dao']();
      await v3['spawn-beacon']();
      await v3['genesis-configure'](paramsFile);
      await v3['fund-reserve']();
      await v3['fund-treasury']();
      await v3['spawn-fair']();
      await v3['configure-fair']();
      await v3['fund-fair'](40); // a float of 10 requests at requestPrice 4
      // The fast tier on the existing committee; the three rng-provider
      // daemons are repointed at it live (deploy/nodes.sh beacon <fast>).
      await v3['spawn-fast']();
      await v3['genesis-configure-fast']();
      // A fresh deploy has no predecessor beacon (v3-params.json predecessor "").
      // RNG Labs stakes its launch stake (LABS_STAKE_RNG, or RNG_LABS_STAKE):
      // the majority of the stake at launch, said openly in PERMISSIONLESS.md.
      await v3['dao-stake']();
      // Launch: the DAO becomes the only owner of every protocol, and the
      // wallet renounces in the same step; read back gov.wallet = false.
      await v3['dao-handover']();
      // Validators bond only once the wallet is renounced: nothing the wallet
      // could still do touches a bond. Each launch validator gets validatorRng
      // (100,000) and bonds all of it, 4 x stake, from day one: rank is capped
      // bond, so a newcomer must bond as much to outrank them (PERMISSIONLESS.md
      // P2). One transfer does both.
      await v3['bond-for'](state.genesis.validatorRng, path.join(HERE, 'anyhonest-validators.json'));
      await v3['dao-propose'](path.join(HERE, 'proposals', '001-handover-proof.json'));
      log({ op: 'check', sameScheduler: sameScheduler(state, ['token', 'dao', 'beacon', 'fair', 'fast']), scheduler: state.scheduler });
    },
  };

  // Legacy: the live v2 beacon (MZMoXv-2, old TEST-RNG) until cutover.
  const old = () => { if (!isPid(state.anyHonest)) throw new Error(`no anyHonest in ${STATE}`); return state.anyHonest; };
  const legacyCmds = {
    'legacy-info': async () => console.log(JSON.stringify(await key(old(), 'beaconinfo'), null, 1)),
    'legacy-tune': (...kv) => {
      const params = Object.fromEntries(kv.map((a) => a.split('=')).map(([k, v]) => [k, Number(v)]));
      if (!Object.keys(params).length || Object.values(params).some((v) => !Number.isSafeInteger(v))) throw new Error('legacy-tune key=integer ...');
      return send(old(), 'Configure', { data: JSON.stringify(params) });
    },
    'legacy-reinstate': async (...targets) => {
      const info = targets.length ? null : await key(old(), 'beaconinfo');
      for (const address of targets.length ? targets : (info?.validators || []).filter((v) => v.suspended).map((v) => v.address)) {
        await send(old(), 'Admin.Reinstate', { data: JSON.stringify({ address }) });
      }
    },
    'legacy-bond': async (units = '25000', ...targets) => {
      const list = targets.length ? targets : state.anyHonestValidators || [];
      for (const address of list) {
        await send(state.token, 'Transfer', { tags: { Recipient: old(), Quantity: atomsOf(units), 'X-For': address, 'X-Bond': 'true' } });
      }
    },
    'legacy-set-successor': (from, to) => {
      if (!isPid(from) || (to !== '' && !isPid(to))) throw new Error('legacy-set-successor <old> <new|"">');
      return send(from, 'Admin.Set-Successor', { data: JSON.stringify({ successor: to }) });
    },
    'legacy-move-reserve': async (from) => {
      if (!isPid(from)) throw new Error('legacy-move-reserve <old>');
      const info = await key(from, 'beaconinfo');
      const next = info && await key(info.successor, 'beaconinfo');
      // A reserve in one token cannot fund a beacon on another: the successor
      // would refuse the Credit-Notice and the atoms would be stranded.
      if (!DRY && (!info || !next || next.token !== info.token)) {
        throw new Error(`refused: successor ${info?.successor} uses token ${next?.token}, the reserve is in ${info?.token}`);
      }
      return send(from, 'Admin.Move-Reserve');
    },
    'legacy-beacon-info': async () => console.log(JSON.stringify(await key(state.beacon, 'beaconinfo'), null, 1)),
    'legacy-request': async (id = `req-${Date.now()}`) => {
      const r = await send(state.beacon, 'Request-Random', { tags: { Tier: 'beacon', 'Request-Id': id } });
      console.log(r.output);
    },
    'legacy-verify': async (roundArg) => {
      const bls = await import('../validator/bls.mjs');
      const round = Number(roundArg || (await key(state.beacon, 'beaconinfo'))?.round);
      const record = (await key(state.beacon, 'beaconstate'))?.rounds?.[String(round)];
      if (!record) throw new Error(`finalized round ${round} is missing from beacon state`);
      const message = `hyperbeam/rng/v1|${state.beacon}|${round}`;
      if (!bls.verify(state.groupKey, message, record.signature)) throw new Error(`round ${round} BLS signature failed verification`);
      if (record.value !== sha256(Buffer.from(`hyperbeam/rng/v1/round|${message}|${record.signature}`, 'latin1'))) throw new Error('value mismatch');
      console.log(JSON.stringify(record, null, 1));
    },
  };

  const fn = v3[cmd] || legacyCmds[cmd];
  if (!fn) throw new Error(`unknown command ${cmd}; see the header of deploy/deploy.mjs`);
  await fn(...pos);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message || e); process.exit(1); });
}
