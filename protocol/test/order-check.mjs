// Iteration-order check for the contract suites (RNG_PAIRS=asc|desc).
//
// Luerl (lua-patch@1.0) walks `pairs` in sorted key order; PUC Lua
// (wasm-patch@1.0, and the AOS module these suites run in) walks it in hash
// order. A contract that lets `pairs` order reach its state, its replies or
// which items a bounded batch picks would publish different bytes on the two.
// With RNG_PAIRS set, a runner:
//   - replaces `pairs` before the contract loads with one that walks the keys
//     sorted ascending (`asc`, Luerl's order) or descending (`desc`);
//   - wraps the contract's `compute` and folds a canonical serialisation of
//     every result (keys sorted, so the serialiser itself is order-free) into
//     a 64-bit FNV-1a digest, printed as `TRANSCRIPT <hex> <n>`.
// Equal digests under asc and desc mean no order leak the suite exercises:
//   node protocol/test/order-check.mjs        runs every suite both ways
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORDER = process.env.RNG_PAIRS;
if (ORDER && ORDER !== 'asc' && ORDER !== 'desc') throw new Error('RNG_PAIRS must be asc or desc');

/** Goes first in the bundle: the ordered `pairs`. */
export const orderPrelude = () => (!ORDER ? '' : `do
  local rawpairs, sort, type, tostring, getmetatable, rawget = pairs, table.sort, type, tostring, getmetatable, rawget
  local function before(a, b)
    local ta, tb = type(a), type(b)
    if ta ~= tb then return ta < tb end
    if ta == "number" or ta == "string" then return a < b end
    return tostring(a) < tostring(b)
  end
  local cmp = ${ORDER === 'asc' ? 'before' : 'function(a, b) return before(b, a) end'}
  pairs = function(t)
    local mt = getmetatable(t)
    if type(mt) == "table" and rawget(mt, "__pairs") then return mt.__pairs(t) end
    local keys = {}
    for k in rawpairs(t) do keys[#keys + 1] = k end
    sort(keys, cmp)
    local i = 0
    return function()
      while true do
        i = i + 1
        local k = keys[i]
        if k == nil then return nil end
        local v = t[k]
        if v ~= nil then return k, v end
      end
    end, t, nil
  end
  RngOrderRawPairs = rawpairs
end`);

/** Goes after the contract, before the suite: the transcript around `compute`. */
export const transcriptHook = () => (!ORDER ? '' : `do
  local rawpairs, sort, type, tostring, concat, byte, mathtype = RngOrderRawPairs, table.sort, type, tostring, table.concat, string.byte, math.type
  local h, n = -3750763034362895579, 0
  -- RNG_TRANSCRIPT_EACH: every call's own digest, one per line;
  -- RNG_TRANSCRIPT_AT=k: call k serialised in full (to find a difference).
  local Full = ${process.env.RNG_TRANSCRIPT_EACH ? '{}' : 'nil'}
  local AT = ${Number(process.env.RNG_TRANSCRIPT_AT) || 0}
  local function fold(s)
    local one = -3750763034362895579
    for i = 1, #s do
      local b = byte(s, i)
      h = (h ~ b) * 1099511628211
      one = (one ~ b) * 1099511628211
    end
    return one
  end
  local function ser(v, seen)
    local t = type(v)
    if t == "string" then return "s" .. #v .. ":" .. v end
    if t == "number" then return (mathtype(v) or "n") .. ":" .. tostring(v) end
    if t == "boolean" or t == "nil" then return t .. ":" .. tostring(v) end
    -- A function (userdata, thread) prints its address, which differs between runs.
    if t ~= "table" then return t end
    if seen[v] then return "<cycle>" end
    seen[v] = true
    local keys = {}
    for k in rawpairs(v) do keys[#keys + 1] = { ser(k, seen), k } end
    sort(keys, function(a, b) return a[1] < b[1] end)
    local out = {}
    for i, p in ipairs(keys) do out[i] = p[1] .. "=" .. ser(v[p[2]], seen) end
    seen[v] = nil
    return "{" .. concat(out, ",") .. "}"
  end
  local inner = compute
  if type(inner) == "function" then
    compute = function(...)
      local r = table.pack(inner(...))
      n = n + 1
      local line = ser(r, {})
      local one = fold(line)
      if Full then Full[#Full + 1] = string.format("%d %016x", n, one) end
      if n == AT then Full = Full or {}; Full[#Full + 1] = line end
      return table.unpack(r, 1, r.n)
    end
  end
  function RngTranscriptDigest()
    local d = string.format("TRANSCRIPT %016x %d", h, n)
    if Full then d = d .. "\\n" .. concat(Full, "\\n") end
    return d
  end
end`);

/** A suite's Lua fixtures, kept for the second run when RNG_FIXTURES names a
 *  file: the beacon suites deal fresh keys every run, so both orders must
 *  see the same ones for their transcripts to compare. */
export function sameFixtures(build) {
  const file = process.env.RNG_FIXTURES;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const text = build();
  if (file) fs.writeFileSync(file, text);
  return text;
}

/** The Eval's last line: the suite's verdict, the digest line first when on. */
export const evalTail = (runner) => (!ORDER ? `\nreturn ${runner}()`
  : `\nlocal __r = ${runner}()\nreturn RngTranscriptDigest() .. "\\n" .. __r`);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const suites = ['run-token-tests.mjs', 'run-beacon-tests.mjs', 'run-anyhonest-tests.mjs', 'run-fair-tests.mjs'];
  let failed = false;
  for (const suite of suites) {
    const digest = {};
    const fixtures = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rng-order-')), 'fixtures.lua');
    for (const order of ['asc', 'desc']) {
      const out = execFileSync(process.execPath, [path.join(HERE, suite)],
        { env: { ...process.env, RNG_PAIRS: order, RNG_FIXTURES: fixtures }, maxBuffer: 1 << 28 }).toString();
      const line = /TRANSCRIPT [0-9a-f]+ \d+/.exec(out);
      if (!line) throw new Error(`${suite}: no TRANSCRIPT line`);
      digest[order] = line[0];
    }
    const same = digest.asc === digest.desc;
    failed ||= !same;
    console.log(`${same ? 'same' : 'DIFFERS'}  ${suite}  asc ${digest.asc}  desc ${digest.desc}`);
  }
  process.exit(failed ? 1 : 0);
}
