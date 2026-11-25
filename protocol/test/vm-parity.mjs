// The Any-Honest beacon on wasm-patch@1.0 against lua-patch@1.0 (Luerl): the
// SAME spawn bundle (deploy.mjs patchSources.anyHonest), the SAME requests, one
// after another on one VM each, and every slot's response compared: its
// replies, outbox and published patches (as a set: two VMs may walk `pairs` in
// different orders, which moves no state), plus the beacon's whole internal
// state every 100 slots and at the end.
//
//   PARALITH_MONO=<checkout with the pinned runtime> node protocol/test/vm-parity.mjs
//       [--stream suite|rounds|both] [--rounds 600] [--image hb-rng:547c0f57d]
//
// suite:  every request protocol/test/anyhonest_test.lua sends (RNG_RECORD),
//         rng@1.0 answered by the suite's mock on both sides.
// rounds: genesis, three validators, then --rounds rounds of batched Acts
//         (commit r, reveal r - 1) with a funded request every 5th round; real
//         puzzles, rng@1.0 answered by the runtime's natives (wasm) and by
//         HyperBEAM's dev_rng (Luerl).
// Luerl runs in Docker on a HyperBEAM image (its luerl and dev_rng).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchSources, rngRuntime } from '../../deploy/deploy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const PM = path.resolve(process.env.PARALITH_MONO || 'C:/REPO/paralith-mono');
const IMAGE = arg('--image', 'hb-rng:547c0f57d');
const STREAM = arg('--stream', 'both');
const ROUNDS = Number(arg('--rounds', 600));
const WORK = path.join(ROOT, '.parity');
fs.mkdirSync(WORK, { recursive: true });
const { WasmLua } = await import(pathToFileURL(path.join(PM, 'backend/native/wasm-lua/host.mjs')).href);
const runtime = rngRuntime({ pm: PM });
const module = await WebAssembly.compile(runtime.bytes);
const addr = (s) => s.padEnd(43, '_');

// --- the compared value -----------------------------------------------------
// Typed and key-sorted, so it reads the same whatever order a VM walks a
// table in: an integer and a float holding the same number differ.
const PARITY = `
do
  local inner = compute
  local sort, concat, mtype, fmt, tostring, type, pairs, ipairs = table.sort, table.concat, math.type, string.format, tostring, type, pairs, ipairs
  local function ser(v, seen)
    local t = type(v)
    if t == "string" then return "s" .. #v .. ":" .. v end
    if t == "number" then
      if mtype(v) == "integer" then return "i:" .. fmt("%d", v) end
      return "f:" .. fmt("%.17g", v)
    end
    if t == "boolean" or t == "nil" then return t .. ":" .. tostring(v) end
    if t ~= "table" then return t end
    if seen[v] then return "<cycle>" end
    seen[v] = true
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = { ser(k, seen), k } end
    sort(keys, function(a, b) return a[1] < b[1] end)
    local out = {}
    for i, p in ipairs(keys) do out[i] = p[1] .. "=" .. ser(v[p[2]], seen) end
    seen[v] = nil
    return "{" .. concat(out, ",") .. "}"
  end
  local n = 0
  compute = function(a, b, c)
    if b ~= nil then return inner(a, b, c) end
    local res = inner(a)
    n = n + 1
    local paths = {}
    for i, p in ipairs(res.patches or {}) do paths[i] = ser(p.path, {}) end
    local sorted = {}
    for i, p in ipairs(res.patches or {}) do sorted[i] = ser(p, {}) end
    sort(sorted)
    local line = ser(res.results, {}) .. " |P| " .. concat(sorted, ";") .. " |O| " .. concat(paths, ";")
    if n % 100 == 0 or ParityFinal == n then line = line .. " |S| " .. ser(Timelock, {}) end
    ParityLast = (line:gsub("\\n", "\\\\n"))
    res.patches[#res.patches + 1] = { path = "__parity", value = ParityLast }
    return res
  end
end
`;

// --- streams ------------------------------------------------------------------

function suiteStream() {
  const rec = path.join(WORK, 'suite.json'), fix = path.join(WORK, 'fixtures.lua');
  execFileSync(process.execPath, [path.join(HERE, 'run-anyhonest-tests.mjs')],
    { env: { ...process.env, RNG_RECORD: rec, RNG_FIXTURES: fix }, stdio: ['ignore', 'pipe', 'inherit'] });
  const requests = JSON.parse(fs.readFileSync(rec, 'utf8'));
  // The suite's rng@1.0 mock (anyhonest_test.lua), the same on both sides.
  const prelude = [fs.readFileSync(fix, 'utf8'), `
RngDeviceResolve = function(m)
  local key = (m.path:gsub("^/~rng@1.0/", ""))
  for _, f in ipairs(DEVICE_FIELDS[key] or {}) do key = key .. "|" .. tostring(m[f]) end
  if not F.dev[key] then return "ok", { valid = false, reason = "not in the mock" } end
  return "ok", F.dev[key]
end`].join('\n');
  return { name: 'suite', owner: addr('owner'), sched: addr('scheduler'), prelude, requests };
}

const N = BigInt('0xc7970ceedcc3b0754490201a7aa613cd73911081c790f5f1a8726f463550bb5b'
  + '7ff0db8e1ea1189ec72f93d1650011bd721aeeacc2acde32a04107f0648c2813'
  + 'a31f5b0b7765ff8b44b4b6ffc93384b646eb09c7cf5e8592d40ea33c80039f35'
  + 'b4f14a04b51f7bfd781be4d1673164ba8eb991c2c4d730bbbe35f592bdef524a'
  + 'f7e8daefd26c66fc02c479af89d64d373f442709439de66ceb955f3ea37d5159'
  + 'f6135809f85334b5cb1813addc80cd05609f10ac6a95ad65872c909525bdad32'
  + 'bc729592642920f24c61dc5b3c3b7923e56b16a4d9d373d8721f24a3fc0f1b31'
  + '31f55615172866bccc30f95054c824e733a5eb6817f7bc16399d48c6361cc7e5');
const shaBuf = (s) => crypto.createHash('sha256').update(s, 'latin1').digest();
const big = (h) => BigInt('0x' + h);
const hex = (n) => n.toString(16);
function modPow(b, e, m = N) {
  let r = 1n;
  b %= m;
  for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; }
  return r;
}
function expand(s, bits) {
  const parts = [];
  for (let k = 0; parts.length * 256 < bits; k++) parts.push(shaBuf(`${s}|${k}`));
  return big(Buffer.concat(parts).toString('hex')) >> BigInt(parts.length * 256 - bits);
}
const G = modPow(expand('rng/timelock/g', 2112) % N, 2n);
const SMALL = [];
for (let n = 2; n < 1000; n++) if (SMALL.every((p) => n % p)) SMALL.push(n);
function isPrime(n) {
  for (const p of SMALL) if (n % BigInt(p) === 0n) return n === BigInt(p);
  let d = n - 1n, s = 0;
  while (!(d & 1n)) { d >>= 1n; s++; }
  next: for (const a of SMALL.slice(0, 20).map(BigInt)) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < s; i++) { x = (x * x) % n; if (x === n - 1n) continue next; }
    return false;
  }
  return true;
}
function challenge(xHex, yHex, t) {
  let l = big(shaBuf(`rng/wesolowski|${xHex}|${yHex}|${t}`).subarray(0, 16).toString('hex')) | (1n << 127n) | 1n;
  while (!isPrime(l)) l += 2n;
  return l;
}

/** A beacon at work: what three live validators and a paying game send. */
function roundsStream(rounds) {
  const owner = addr('owner'), sched = addr('scheduler'), token = addr('rng-token'), game = addr('game');
  const self = addr('beacon'), V = [addr('val-a'), addr('val-b'), addr('val-c')];
  const T = 1024, gh = hex(G), h = modPow(G, 1n << BigInt(T)), hHex = hex(h);
  const l = challenge(gh, hHex, T), hProof = hex(modPow(G, (1n << BigInt(T)) / l));
  const U = 1_000_000;
  let clock = 1_800_000_000_000, slot = 0, ref = 0;
  const out = [];
  const signed = (signer, fields) => ({ target: self, ...fields,
    commitments: { c: { type: 'rsa-pss-sha256', committer: signer, committed: ['target', 'data', 'action'] } } });
  const delivery = (pid, fields) => ({ ...signed(sched, fields), 'from-process': pid });
  const send = (body, advance = 100) => { clock += advance; slot += 1; out.push({ body, timestamp: clock, process: self, slot }); };
  const credit = (fields) => send(delivery(token, { Action: 'Credit-Notice', Reference: `t${++ref}`, ...fields }));
  send(signed(owner, { Action: 'Gov.Configure', Data: JSON.stringify({ self, token, unit: U, T, h: hHex, hProof,
    commitWindowMs: 3000, revealWindowMs: 10000, abandonAfterMs: 60000, minCommits: 2, cadenceMs: 0, targetIntervalMs: 0,
    stake: 25000, slash: 1000, heartbeat: 1, roundPrice: 3, requestPrice: 4, subscriptionPrice: 1,
    subscriptionRounds: 1000, crackBounty: 10 }) }));
  for (const v of V) credit({ Sender: owner, Quantity: String(25000 * U), 'X-For': v, 'X-Bond': 'true' });
  for (const v of V) send(signed(v, { Action: 'Ready' }));
  credit({ Sender: owner, Quantity: String(1_000_000 * U), 'X-For': owner, 'X-Foundation': 'true' });
  credit({ Sender: owner, Quantity: String(1_000 * U), 'X-For': owner, 'X-Treasury': 'true' });
  credit({ Sender: game, Quantity: String(100_000 * U) });
  const alpha = (r, v) => hex(big(shaBuf(`alpha|${r}|${v}`).toString('hex')) | 1n);
  const c = new Map();
  const commitOf = (r, v) => {
    const k = `${r}|${v}`;
    if (!c.has(k)) c.set(k, hex(modPow(G, big(alpha(r, v)))));
    return c.get(k);
  };
  for (let r = 1; r <= rounds; r++) {
    if (r % 5 === 0) send(delivery(game, { Action: 'Request-Random', Tier: 'any-honest', 'Request-Id': `req-${r}` }), 20);
    if (r % 50 === 0) send(signed(addr('reader'), { Action: 'Get-Info' }), 20);
    for (const v of V) {
      const data = { commit: { round: r, c: commitOf(r, v) } };
      if (r > 1) data.reveals = [{ round: r - 1, alpha: alpha(r - 1, v) }];
      send(signed(v, { Action: 'Act', Data: JSON.stringify(data) }), 40);
    }
  }
  for (const v of V) send(signed(v, { Action: 'Reveal', Data: JSON.stringify({ round: rounds, alpha: alpha(rounds, v) }) }), 40);
  for (const v of V) send(signed(v, { Action: 'Claim' }), 40);
  return { name: 'rounds', owner, sched, prelude: 'TestHarness = true', requests: out };
}

// --- the two VMs ----------------------------------------------------------------

function bundleFor(s) {
  return [patchSources.anyHonest(s.owner, s.sched), s.prelude,
    `ParityFinal = ${s.requests.length}`, PARITY].join('\n');
}

function runWasm(s, bundle) {
  const rt = new WasmLua(module);
  const init = rt.init({ id: s.requests[0].process, module: bundle });
  if (init.status !== 0) throw new Error(`wasm init: ${JSON.stringify(init.value)}`);
  const lines = [];
  for (const req of s.requests) {
    const t0 = performance.now();
    const res = rt.handle(req);
    const us = Math.round((performance.now() - t0) * 1000);
    if (res.status !== 0) throw new Error(`wasm slot ${req.slot}: ${JSON.stringify(res.error)}`);
    const p = res.patches.find((x) => String(x.path) === '__parity');
    lines.push([us, String(p.value)]);
  }
  return lines;
}

function runLuerl(s, bundle) {
  const dir = path.join(WORK, s.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bundle.lua'), bundle);
  fs.writeFileSync(path.join(dir, 'requests.json'), JSON.stringify(s.requests));
  fs.copyFileSync(path.join(HERE, 'vm_parity.erl'), path.join(dir, 'vm_parity.erl'));
  const mount = dir.replace(/\\/g, '/');
  // Preloaded devices (dev_rng) are compiled by the node at boot, not shipped
  // as beams: compile it here the same way.
  execFileSync('docker', ['run', '--rm', '-v', `${mount}:/w`, '--entrypoint', 'sh', IMAGE, '-c',
    'cd /w && H=/app/_build/default/rel/hb/lib/hb-0.11.1 && '
    + 'erlc -I /app -I /app/src -I $H/include -pa $H/ebin $H/src/preloaded/crypto/dev_rng.erl && '
    + 'erlc vm_parity.erl && erl -noshell -pa /app/_build/default/lib/luerl/ebin '
    + '-pa $H/ebin -pa /w -run vm_parity main bundle.lua requests.json out.txt'],
  { stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 1 << 30 });
  return fs.readFileSync(path.join(dir, 'out.txt'), 'utf8').split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf(' ');
    return [Number(line.slice(0, at)), line.slice(at + 1)];
  });
}

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ms = (us) => (us / 1000).toFixed(2);
let bad = 0;
for (const s of (STREAM === 'both' ? ['suite', 'rounds'] : [STREAM]).map((n) => (n === 'suite' ? suiteStream() : roundsStream(ROUNDS)))) {
  const bundle = bundleFor(s);
  const W = runWasm(s, bundle), L = runLuerl(s, bundle);
  if (W.length !== L.length) throw new Error(`${s.name}: wasm ${W.length} slots, luerl ${L.length}`);
  let same = 0, orderOnly = 0, states = 0;
  const diffs = [];
  for (let i = 0; i < W.length; i++) {
    const [wv, lv] = [W[i][1], L[i][1]];
    if (wv === lv) { same++; if (wv.includes(' |S| ')) states++; continue; }
    const cut = (v) => v.replace(/ \|O\| [^|]*/, '');
    if (cut(wv) === cut(lv)) { orderOnly++; if (wv.includes(' |S| ')) states++; continue; }
    diffs.push(i);
  }
  const acts = s.requests.map((r, i) => (r.body.Action === 'Act' ? i : -1)).filter((i) => i >= 0);
  const wAct = acts.map((i) => W[i][0]), lAct = acts.map((i) => L[i][0]);
  console.log(`${s.name}: ${W.length} slots, ${same} identical, ${orderOnly} identical but for patch order, `
    + `${diffs.length} DIFFERENT; whole state compared at ${states} slots`);
  if (acts.length) {
    console.log(`  Act: wasm (Node JIT) p50 ${ms(q(wAct, 0.5))} / p95 ${ms(q(wAct, 0.95))} ms, `
      + `Luerl p50 ${ms(q(lAct, 0.5))} / p95 ${ms(q(lAct, 0.95))} ms (${acts.length} Acts)`);
  }
  for (const i of diffs.slice(0, 3)) {
    const [a, b] = [W[i][1], L[i][1]];
    let k = 0;
    while (k < a.length && a[k] === b[k]) k++;
    console.log(`  slot ${i + 1} (${s.requests[i].body.Action}) differs at char ${k}:\n    wasm  ...${a.slice(Math.max(0, k - 120), k + 160)}\n    luerl ...${b.slice(Math.max(0, k - 120), k + 160)}`);
  }
  bad += diffs.length;
}
process.exit(bad ? 1 : 0);
