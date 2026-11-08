-- beacon.lua: the RNG "fast" tier: on-demand threshold-BLS randomness.
--
-- Not a beacon: nothing runs on a clock. A round opens only when a paid
-- request is waiting for it, and the 2-of-3 committee signs only rounds that
-- have requests. Better than local randomness (no single party knows the
-- value before the committee signs), weaker than Any-Honest (two colluding
-- operators can predict or choose a value). One message phase: post partials,
-- combine, done.
--
-- A native ~lua@5.3a contract in the paralith-mono style: one `compute(base,
-- req)`, identity from signature commitments only, replies through
-- `base.results.outbox`, and every read published as a flat key (GET
-- /<pid>~process@1.0/now/<key>). Bundled after vendor/json.lua,
-- vendor/jsonenc.lua (`encode`, `jsonObject`) and lib/rng.lua (global `rng`).
--
-- Flow: a requester pays in RNG (v3 token, sequenced-v1) either into a
-- balance (Transfer with X-For) and then sends Request-Random, or in one
-- message (Transfer with X-Request-Id: pay and request). The request binds to
-- the next unsigned round; the committee signs that round; the process derives
-- one value per request and sends each requesting PROCESS one RNG-Result.
-- A wallet reads its round from `beaconstate.seen["<wallet>|<id>"]` and its
-- value from the round record (pushes to wallets stall the node's delivery).
-- A round the committee does not sign in time is abandoned: its requests are
-- refunded in full and requesting processes get RNG-Error Round-Abandoned.
--
-- State is bounded (docs/PERMISSIONLESS.md, "State bounds"): request ids are
-- remembered GUARD_MS of scheduler time, token references CREDIT_KEEP, finalized rounds
-- ROUND_HISTORY. History lives in the per-slot results: every finalized or
-- abandoned round publishes `beaconround` in its own slot, and
-- `beaconhistory` maps the last HISTORY_KEEP rounds to their slots
-- (deploy/README.md, "History").
--
-- Members exchange partial signatures through this process (Partial), so the
-- nodes never need to reach each other directly: each reads the others'
-- partials from the published `beaconpartials` key, combines t of them, and
-- posts the result (Round).
--
-- Until the vrf@1.0 device ships, a round finalizes only when `threshold`
-- committee members post the same signature (each verifies it off-chain
-- first), so one stolen key cannot inject a value. With verification =
-- "device", one post carrying a valid group signature is enough.
--
-- Governance mirrors anyhonest.lua and paralith-mono's gov.lua (vendor/gov.lua,
-- bundled ahead of this file). The launch wallet bootstraps (spawn, genesis
-- Configure), names the DAO (Gov.Set-Dao) and renounces (Gov.Renounce-Wallet);
-- from then on the DAO, a from-process our scheduler attests, is the only
-- owner. Its money and code actions (the committee, the protocol's fee
-- share, code, the DAO seat) wait for an Effective-At at least 24 h after
-- they arrive (Gov.Apply), and while one waits the exit hatch is open: a
-- member may leave at once (Exit-Now). Fees, pause and resume apply on
-- receipt. Governance cannot mint, or move a balance or a member's earnings.
-- A committee change means a new DKG ceremony.

local json = require(".json")

-- Finalized rounds kept in state for Get-Round reads; older ones age out
-- (readable at their slot, see `beaconhistory`).
local ROUND_HISTORY = 32
local HISTORY_KEEP = 1024    -- rounds listed in `beaconhistory` (round -> slot)
-- Replays: the scheduler assigns a signed message at most once per process
-- (dev_scheduler_server write_assignment: a copy is refused 409 "Message
-- already scheduled."), so a copy of a signed request never reaches us. The
-- `seen` window below is only belt and braces, keyed by scheduler time (the
-- assignment's timestamp, never a time the sender writes).
local GUARD_MS = 600000      -- a request id is remembered this long (scheduler time)
local CREDIT_KEEP = 1000     -- token references kept before the oldest fold into `creditFloor`
local EXECUTED_KEEP = 256    -- DAO proposals remembered as executed (see markExecuted)
-- A round left unsigned abandonAfterMs after its oldest request is abandoned
-- and refunded. Once its value can be computed from what was published (t
-- partials, or a posted signature), not before ABANDON_CAP_MS after it locked:
-- abandoning then would let members who dislike a value they have seen void
-- it (selective abort), so that costs them a week's delay.
local ABANDON_CAP_MS = 7 * 86400000

local SIGNATURE_ALGS = { ["rsa-pss-sha512"] = true, ["rsa-pss-sha256"] = true }

local MAX_FEE = 1000000 -- RNG per signer or protocol share of one request

--- gov.lua's owner record (GovState) at spawn: the wallet on, no DAO.
local function freshOwners(wallet)
  return { dao = "", wallet = wallet, approved = "", approvedAt = 0, code = { sha = "", version = 0 } }
end

-- All state lives in one table, published whole as `beaconstate` after every
-- message and restored from it when the VM comes back without its globals.
-- Keys that are round numbers are strings so the JSON round trip keeps them.
local function freshState()
  return {
    rev = 0,
    self = "",            -- this process id, used in what the committee signs
    token = "",           -- RNG token process id; set once (genesis Gov.Configure)
    unit = 1000000,       -- token atoms per 1 RNG (Denomination 6)
    committee = {},       -- address -> index
    threshold = 2,        -- signers needed per round
    groupKey = "",        -- group public key (hex)
    sharePublicKeys = {}, -- committee address -> DKG public share key
    verification = "attestations", -- testnet fallback; production uses rng@1.0
    signerFee = 1,        -- RNG per request to each signer of its round
    protocolFee = 1,      -- RNG per request to the protocol (spent by governance)
    round = 0,            -- last finalized (or abandoned past its lock) round
    lastRoundAt = 0,
    abandonAfterMs = 1800000, -- an unsigned round's requests are refunded this long after the oldest
    rounds = {},          -- "r" -> { signature, value, signers }, the last ROUND_HISTORY
    history = {},         -- { round, slot[, "abandoned"] }, oldest first; published as `beaconhistory`
    balances = {},        -- address -> RNG
    -- Pay at deposit: address -> purse (lib/rng.lua) of batches { n, price,
    -- protocol }, the price and protocolFee in force when each was credited.
    -- A request pays (and pays out) its batch's price; a fee or committee
    -- change binds only later deposits.
    purses = {},
    accrued = {},         -- signer address -> RNG earned, unclaimed
    protocolAccrued = 0,
    pending = {},         -- "r" -> list of { requester, requestId, charged, protocol, process }
    pendingCount = 0,
    lockedRound = 0,      -- first Partial/Round closes this round to new requests
    lockedAt = 0,         -- when it did
    seen = {},            -- requester|requestId -> round it was bound to, for GUARD_MS
    seenQueue = {},       -- { requester|requestId, forget-at ms (now + GUARD_MS) }, in time order
    credited = {},        -- token reference seq -> true (notices may arrive twice)
    creditFloor = 0,      -- every reference seq at or below this counts as credited
    attest = {},          -- "r" -> { by = member -> sig, sigs = sig -> members }
    equivocations = {},   -- member -> conflicting signatures posted
    partials = { round = 0, by = {} }, -- open round's partial signatures, by member
    -- Governance: gov.lua's GovState, kept here so it is published, restored
    -- and rolled back with the rest of the state (bindOwners).
    owners = freshOwners(true),
    -- executed: "dao|X-Dao-Proposal" -> true, the last EXECUTED_KEEP
    -- (executedOrder); executedFloor: the highest numeric proposal pruned.
    -- pending: id -> the DAO's actions waiting for their Effective-At.
    gov = { executed = {}, executedOrder = {}, executedFloor = 0, pending = {}, nextId = 1 },
    paused = false,
    transferSeq = 0,      -- X-Transfer-Sequence of the last token Transfer; only ever increases
  }
end
Beacon = Beacon or freshState()
Beacon.partials = Beacon.partials or { round = 0, by = {} }

local function int(v, default)
  if v == nil then return default end
  local n = tonumber(v)
  if not n then return default end
  return math.tointeger(n) or default
end

-- json.decode floats every number; turn integral floats back into integers.
local function deflate(v)
  if type(v) == "number" then return math.tointeger(v) or v end
  if type(v) ~= "table" then return v end
  for k, x in pairs(v) do v[k] = deflate(x) end
  return v
end

local function restore(base)
  local published = int(base and base.beaconrev, 0)
  if published <= int(Beacon.rev, 0) then return false end
  local ok, saved = pcall(json.decode, base.beaconstate or "")
  if ok and type(saved) == "table" then
    Beacon = freshState()
    -- A published state without owners has none: never re-arm the wallet.
    Beacon.owners = freshOwners(false)
    for k, v in pairs(deflate(saved)) do Beacon[k] = v end
    local hok, history = pcall(json.decode, base.beaconhistory or "")
    if hok and type(history) == "table" and type(history.rounds) == "table" then
      Beacon.history = deflate(history.rounds)
    end
    return true
  end
  return false
end

--- gov.lua reads and writes the global GovState; point it at the state's
--- owner record, so owners are published, restored and rolled back with the
--- state. Code installed in a VM that is gone is not running here (the
--- spawn module is): its root comes back approved, for anyone to resend.
local function bindOwners(reloaded)
  local o = Beacon.owners
  if type(o) ~= "table" then o = freshOwners(false); Beacon.owners = o end
  if type(o.code) ~= "table" then o.code = { sha = "", version = 0 } end
  if reloaded and (o.code.sha or "") ~= "" then
    if (o.approved or "") == "" then o.approved, o.approvedAt = o.code.sha, 0 end
    o.code = { sha = "", version = int(o.code.version, 0) }
  end
  o.approvedAt = int(o.approvedAt, 0)
  GovState = o
end

local function deepCopy(v)
  if type(v) ~= "table" then return v end
  local t = {}
  for k, x in pairs(v) do t[k] = deepCopy(x) end
  return t
end

--- A message must be signed for THIS beacon: a member's Round or Partial, or
--- the owner's Configure, signed for another beacon is refused, not replayed.
-- BEGIN target door (game/kernel/door.lua; copies checked by target-door.test.mjs)
function TargetRefusal(msg, req)
  local c = type(msg) == "table" and (msg.commitments or msg.Commitments) or nil
  if type(c) ~= "table" or next(c) == nil then return nil end
  local algs = { ["rsa-pss-sha512"] = true, ["rsa-pss-sha256"] = true }
  local signatures, ids = {}, {}
  for id, s in pairs(c) do
    if type(s) == "table" and s.committer and algs[s.type or s.alg] then
      signatures[#signatures + 1] = s
      ids[#ids + 1] = id
    end
  end
  if #signatures == 0 then return "Refused: not signed" end
  local self = type(req) == "table" and req.process or nil
  if type(self) ~= "string" or #self ~= 43 then return "Refused: this process id is unknown" end
  if #signatures == 1 and ids[1] == self then return nil end
  if msg.target ~= self then return "Refused: not signed for this process" end
  for _, s in ipairs(signatures) do
    local bound = false
    for _, key in pairs(type(s.committed) == "table" and s.committed or {}) do
      if key == "target" then bound = true end
    end
    if not bound then return "Refused: the signature does not commit target" end
  end
  return nil
end
-- END target door

---------------------------------------------------------------------------
-- Identity (same rules as anyhonest.lua)
---------------------------------------------------------------------------

--- The one wallet that signed the message. Two signatures by different
--- committers are nobody.
local function provenSigner(msg)
  local c = msg.commitments or msg.Commitments
  if type(c) ~= "table" then return nil end
  local signer = nil
  for _, commitment in pairs(c) do
    if type(commitment) == "table" and commitment.committer
       and SIGNATURE_ALGS[commitment.type or commitment.alg] then
      if signer and signer ~= commitment.committer then return nil end
      signer = commitment.committer
    end
  end
  return signer
end

local function schedulerAddress(base)
  if type(base) ~= "table" then return nil end
  local found = base["scheduler-location"] or base.SchedulerLocation or base["scheduler_location"]
  if type(found) == "string" and #found == 43 then return found end
  local p = base.process or base.Process
  if type(p) == "table" then
    local nested = p["scheduler-location"] or p.SchedulerLocation
    if type(nested) == "string" and #nested == 43 then return nested end
  end
  return nil
end

--- True while the current message is a process delivery our scheduler vouched for.
local FromProcess = false

--- A wallet is its signer; a process is the `from-process` our own scheduler
--- vouches for. Nothing unsigned is anybody, and the scheduler itself is
--- nobody: its signature only vouches for a from-process.
local function actor(msg, base)
  local signed = provenSigner(msg)
  local fromProcess = msg["from-process"] or msg.FromProcess
  FromProcess = false
  if not signed then return nil end
  if signed == schedulerAddress(base) then
    if not fromProcess then return nil end
    FromProcess = true
    return fromProcess
  end
  return signed
end

local function isAoAddress(s)
  return type(s) == "string" and #s == 43 and s:match("^[%w_%-]+$") ~= nil
end

local function resolveOwner(base)
  if Owner and Owner ~= "" then return Owner end
  local p = base and (base.process or base.Process)
  if type(p) == "table" then Owner = provenSigner(p) end
  return Owner
end


---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

local function reply(base, value, outbox)
  base.results = {
    output = { data = type(value) == "string" and value or encode(value) },
    outbox = outbox or {},
  }
  return base
end

--- Errors are pushed (RNG-Error) only to processes; a wallet reads the reply.
local function fail(base, message, to, extra)
  local outbox = {}
  if to and FromProcess then
    local data = { error = message }
    for k, v in pairs(extra or {}) do data[k] = v end
    outbox["rng-error"] = { target = to, Action = "RNG-Error", Data = encode(data) }
  end
  return reply(base, { error = message }, outbox)
end

--- Messages the round housekeeping (advance) sends, added to the reply.
local Notices = {}
--- Rounds this message finalized or abandoned: { round, slot[, "abandoned"] },
--- added to `history` only once the message succeeds; and their records,
--- published in this slot as `beaconround` (finalized) and `beaconabandoned`.
local HistoryNew, Finalized, Abandoned = {}, nil, nil
--- The slot being computed (the node's assignment), or nil when unknown.
local Slot = nil
--- This message's scheduler time.
local Now = 0

local function dataOf(msg)
  local d = msg.Data or msg.data
  if type(d) == "string" then
    local ok, v = pcall(json.decode, d)
    d = ok and v or nil
  end
  return type(d) == "table" and deflate(d) or {}
end

--- Each request's value, from the round value. v2 binds the requester, as
--- Any-Honest does (`hyperbeam/rng/any-honest/v1/request|value|requester|id`):
--- under v1, H("hyperbeam/rng/v1/request|" .. value .. "|" .. requestId), two
--- requesters using the same Request-Id in one round got the same value. A
--- round record names its rule in `derivation`; one without it is v1.
local REQUEST_DERIVATION = "hyperbeam/rng/fast/v2/request"
local function requestValue(value, requester, requestId)
  return rng.hex(rng.sha256(REQUEST_DERIVATION .. "|" .. value .. "|" .. requester .. "|" .. requestId))
end

--- What the committee signs for round r.
local function roundMessage(r)
  return "hyperbeam/rng/v1|" .. tostring(Beacon.self) .. "|" .. tostring(r)
end

--- RNG price of one request: signerFee to each of `threshold` signers, plus protocolFee.
local function price()
  return int(Beacon.threshold, 2) * int(Beacon.signerFee, 1) + int(Beacon.protocolFee, 1)
end

local function add(map, key, amount)
  map[key] = int(map[key], 0) + amount
end

--- Every Transfer carries the next X-Transfer-Sequence (the token's
--- sequenced-v1 stream for process senders); the counter never goes back,
--- and a handler that fails is rolled back, so it takes no number.
local function transferAtoms(to, atoms, note)
  Beacon.transferSeq = int(Beacon.transferSeq, 0) + 1
  return {
    target = Beacon.token, Action = "Transfer", Recipient = to,
    Quantity = string.format("%d", atoms), ["X-Note"] = note,
    ["X-Transfer-Sequence"] = string.format("%d", Beacon.transferSeq),
  }
end

local function transferOut(to, rngAmount, note) return transferAtoms(to, rngAmount * int(Beacon.unit, 1), note) end

local function count(t) local n = 0 for _ in pairs(t) do n = n + 1 end return n end

--- Marks pay-and-request's own Request-Random (a key no tag can be).
local PAY_NOW = {}
local function nowPrices() return { price = price(), protocol = int(Beacon.protocolFee, 1) } end

--- `addr`'s purse, matched to its balance (one from before purses joins at today's prices).
local function purseOf(addr)
  Beacon.purses = type(Beacon.purses) == "table" and Beacon.purses or {}
  local p = rng.purseMatch(Beacon.purses[addr] or {}, int(Beacon.balances[addr], 0), nowPrices())
  Beacon.purses[addr] = p
  return p
end

--- Credit `n` RNG at `prices` (default: now); false when the purse is full.
local function creditBalance(addr, n, prices)
  if not rng.purseAdd(purseOf(addr), n, prices or nowPrices()) then return false end
  add(Beacon.balances, addr, n)
  return true
end

--- Requests that will never get a value: refunded exactly what each was
--- charged (to its balance; Withdraw pays it out through the token's
--- sequenced-v1 stream), processes told. Signers are paid nothing for it.
local function refundPending(r)
  local key = tostring(r)
  local list = Beacon.pending[key] or {}
  for i, p in ipairs(list) do
    -- Back at the prices it was paid at (a full purse: back to the wallet).
    if not creditBalance(p.requester, int(p.charged, 0), { price = int(p.charged, 0), protocol = int(p.protocol, 0) }) then
      Notices["rng-refund-" .. key .. "-" .. i] = transferOut(p.requester, int(p.charged, 0), "RNG request refund")
    end
    if p.process then
      Notices["rng-abandoned-" .. key .. "-" .. i] = { target = p.requester, Action = "RNG-Error",
        Data = encode({ error = "Round-Abandoned", requestId = p.requestId, round = r }) }
    end
  end
  Beacon.pending[key] = nil
  Beacon.pendingCount = int(Beacon.pendingCount, 0) - #list
  return list
end

--- True once round r's value can be computed from what this process
--- published: threshold partials, or a posted group signature.
local function valueKnowable(r)
  local key = tostring(r)
  if Beacon.attest[key] and next(Beacon.attest[key].by or {}) then return true end
  return int(Beacon.partials.round, 0) == r and count(Beacon.partials.by) >= int(Beacon.threshold, 2)
end

--- When the open round's requests are refunded (nil: nothing waits).
local function abandonAt(r)
  local list = Beacon.pending[tostring(r)]
  if not list or #list == 0 then return nil end
  local oldest = math.maxinteger
  for _, p in ipairs(list) do oldest = math.min(oldest, int(p.at, 0)) end
  local due = oldest + int(Beacon.abandonAfterMs, 1800000)
  if int(Beacon.lockedRound, 0) == r and valueKnowable(r) then
    due = math.max(due, int(Beacon.lockedAt, 0) + ABANDON_CAP_MS)
  end
  return due
end

local function info()
  local members = {}
  for addr, idx in pairs(Beacon.committee) do
    members[#members + 1] = {
      address = addr, index = int(idx, 0), ["public-key"] = Beacon.sharePublicKeys[addr],
    }
  end
  table.sort(members, function(a, b) return a.index < b.index end)
  local r = int(Beacon.round, 0)
  local nextRound = r + 1
  local requestRound = int(Beacon.lockedRound, 0) == nextRound and nextRound + 1 or nextRound
  local roundPending = #(Beacon.pending[tostring(nextRound)] or {})
  local p = price()
  return {
    tier = "fast", derivation = REQUEST_DERIVATION, mode = Beacon.paused and "paused" or "on-demand",
    round = r, nextRound = nextRound, requestRound = requestRound,
    -- No cadence: a round opens as soon as a request waits for it. Kept at 0
    -- for provider daemons that still compare against it.
    nextRoundAt = 0,
    pendingCount = int(Beacon.pendingCount, 0), roundPendingCount = roundPending,
    lockedRound = int(Beacon.lockedRound, 0), threshold = int(Beacon.threshold, 0),
    committee = members, groupKey = Beacon.groupKey, roundMessage = roundMessage(nextRound),
    -- `beacon` is the tier's internal id, kept for older readers.
    price = { fast = p, beacon = p }, signerFee = int(Beacon.signerFee, 1), protocolFee = int(Beacon.protocolFee, 1),
    token = Beacon.token, unit = int(Beacon.unit, 1), self = Beacon.self,
    protocolAccrued = int(Beacon.protocolAccrued, 0), verification = Beacon.verification,
    -- gov.lua's owners: { dao, wallet, approved, approvedAt, code, version }.
    gov = Gov.info(), paused = Beacon.paused == true, transferSeq = int(Beacon.transferSeq, 0),
    -- The DAO's actions waiting for their Effective-At; while a money or
    -- code one waits, the exit hatch is open (Exit-Now).
    govPending = Gov.pendingView(Gov.queueOf(Beacon.gov), Now), hatch = Gov.hatchOpen(Gov.queueOf(Beacon.gov), Now),
    exitFloorMs = Gov.EXIT_FLOOR_MS,
    abandonAfterMs = int(Beacon.abandonAfterMs, 1800000), abandonAt = abandonAt(nextRound),
    features = { "on-demand", "pay-and-request", "gov", "abandon", "effective-at", "exit-hatch" },
  }
end

local function partialSigners(r)
  if int(Beacon.partials.round, 0) ~= r then return {} end
  local members = {}
  for address, index in pairs(Beacon.committee) do
    if Beacon.partials.by[address] then members[#members + 1] = { address = address, index = index } end
  end
  table.sort(members, function(a, b) return a.index < b.index end)
  local signers = {}
  for i = 1, math.min(#members, int(Beacon.threshold, 0)) do signers[i] = members[i].address end
  return signers
end

local function verifySignature(publicKey, message, sig)
  if type(ao) ~= "table" or type(ao.resolve) ~= "function" then
    return nil, "Verifier-Unavailable"
  end
  local ok, status, result = pcall(function()
    return ao.resolve({
      path = "/~rng@1.0/verify-bls", ["public-key"] = publicKey,
      message = message, signature = sig,
    })
  end)
  if not ok or status ~= "ok" or type(result) ~= "table" then
    return nil, "Verifier-Unavailable"
  end
  if result.valid ~= true then return false, "Bad-Signature" end
  return true, result.value
end

local function verifyWithDevice(r, sig)
  local message = roundMessage(r)
  local valid, value = verifySignature(Beacon.groupKey, message, sig)
  if not valid then return valid, value end
  local expected = rng.hex(rng.sha256("hyperbeam/rng/v1/round|" .. message .. "|" .. sig))
  if value ~= expected then return false, "Bad-Round-Value" end
  return true
end

---------------------------------------------------------------------------
-- Handlers: H[action](base, msg, from, now)
---------------------------------------------------------------------------

local H = {}

local function configured() return Beacon.token ~= "" and Beacon.groupKey ~= "" end

H["Request-Random"] = function(base, msg, from, now)
  if not from then return fail(base, "Unsigned") end
  local tier = msg.Tier or "fast"
  local requestId = msg["Request-Id"]
  local ctx = { requestId = requestId }
  -- "beacon" is the tier's old (internal) name.
  if tier ~= "fast" and tier ~= "beacon" then return fail(base, "Tier-Unavailable", from, ctx) end
  if type(requestId) ~= "string" or requestId == "" or #requestId > 128 then
    return fail(base, "Missing-Request-Id", from, ctx)
  end
  local key = from .. "|" .. requestId
  -- A redelivery: the first copy was charged and is (or was) answered.
  if Beacon.seen[key] then
    return reply(base, { duplicate = true, requestId = requestId, round = int(Beacon.seen[key], 0) })
  end
  -- No sender time: a copy of this signed message is refused by the
  -- scheduler; the same id in a new message within GUARD_MS is a duplicate.
  if not configured() then return fail(base, "Not-Configured", from, ctx) end
  if Beacon.paused then return fail(base, "Paused", from, ctx) end
  -- Paid at the price of the batch it comes from (pay at deposit).
  local bal = int(Beacon.balances[from], 0)
  local paid, cost = rng.purseTake(purseOf(from), function(b) return b.price end, msg[PAY_NOW] == true)
  if not paid then
    return fail(base, "Insufficient-Balance", from, { requestId = requestId, balance = bal, price = price() })
  end
  Beacon.balances[from] = bal - cost
  -- The first partial closes a round before its value becomes knowable. Any
  -- later request is assigned to the following round, preventing adaptive
  -- Request-Id grinding against already-published partials.
  local r = int(Beacon.round, 0) + 1
  if int(Beacon.lockedRound, 0) == r then r = r + 1 end
  Beacon.seen[key] = r
  local q = Beacon.seenQueue
  q[#q + 1] = { key, now + GUARD_MS }
  local keyRound = tostring(r)
  local list = Beacon.pending[keyRound] or {}
  list[#list + 1] = { requester = from, requestId = requestId, charged = cost,
    protocol = paid.protocol, process = FromProcess or nil, at = now }
  Beacon.pending[keyRound] = list
  Beacon.pendingCount = int(Beacon.pendingCount, 0) + 1
  return reply(base, { requestId = requestId, round = r, price = cost, balance = Beacon.balances[from] })
end

--- Mark a token reference handled. The token numbers its notices t1, t2, ...
--- (its TransferSeq, which never goes back); past CREDIT_KEEP the oldest folds
--- into the floor, and every seq at or below the floor counts as credited. A
--- replay is refused either way; only a notice that arrives after CREDIT_KEEP
--- newer ones would be refused wrongly (fail-closed: never a double credit).
local function markCredited(seq)
  Beacon.credited[tostring(seq)] = true
  local n, oldest = 0, nil
  for k in pairs(Beacon.credited) do
    n = n + 1
    local x = int(k, 0)
    if not oldest or x < oldest then oldest = x end
  end
  if n > CREDIT_KEEP then
    Beacon.credited[tostring(oldest)] = nil
    if oldest > int(Beacon.creditFloor, 0) then Beacon.creditFloor = oldest end
  end
end

H["Credit-Notice"] = function(base, msg, from, now)
  if Beacon.token == "" then return fail(base, "Not-Configured") end
  if from ~= Beacon.token or not FromProcess then return fail(base, "Not the configured token") end
  local reference = msg.Reference
  if type(reference) ~= "string" or #reference > 24 or not reference:match("^t%d+$") then
    return fail(base, "Invalid-Reference")
  end
  local seq = int(reference:sub(2), nil)
  if not seq then return fail(base, "Invalid-Reference") end
  if seq <= int(Beacon.creditFloor, 0) or Beacon.credited[tostring(seq)] then return reply(base, { duplicate = true }) end
  markCredited(seq)
  local atoms = int(msg.Quantity, 0)
  local unit = int(Beacon.unit, 1)
  local amount = atoms // unit
  local sender = msg.Sender
  local who = msg["X-For"] or sender
  if amount <= 0 or not isAoAddress(who) then
    -- Dust, or no valid account: send it back.
    local outbox = {}
    if atoms > 0 and isAoAddress(sender) then outbox["rng-refund"] = transferAtoms(sender, atoms, "RNG credit refund") end
    return reply(base, { error = "Nothing to credit", refunded = outbox["rng-refund"] and atoms or 0 }, outbox)
  end
  -- Below one whole RNG the remainder cannot be credited: it goes back.
  local dust = atoms - amount * unit
  local function withDust(outbox)
    if dust > 0 and isAoAddress(sender) then
      outbox["rng-dust-refund"] = transferAtoms(sender, dust, "RNG credit remainder refund")
    end
    return outbox
  end
  if msg["X-Request-Id"] then
    -- Pay and request in one message: credit the payer, then request for it
    -- as its own Request-Random would. A refused request leaves the credit
    -- (Withdraw takes it back). The payer may be a wallet, so no push: its
    -- round is in `seen`, its value derives from the round record.
    -- The token reference already makes this notice count once.
    if not isAoAddress(sender) then return fail(base, "Bad-Sender") end
    if not creditBalance(sender, amount) then
      return reply(base, { error = "Too-Many-Price-Batches" }, { ["rng-refund"] = transferAtoms(sender, atoms, "RNG credit refund") })
    end
    FromProcess = false
    -- It pays the price in force now: from the batch just credited.
    local res = H["Request-Random"](base, { ["Request-Id"] = msg["X-Request-Id"], Tier = msg["X-Tier"], [PAY_NOW] = true },
      sender, now)
    local ok, out = pcall(json.decode, res.results.output.data or "")
    out = ok and type(out) == "table" and out or {}
    out.credited, out.account, out.balance = amount, sender, int(Beacon.balances[sender], 0)
    return reply(base, out, withDust(res.results.outbox or {}))
  end
  if not creditBalance(who, amount) then
    local outbox = {}
    if isAoAddress(sender) then outbox["rng-refund"] = transferAtoms(sender, atoms, "RNG credit refund") end
    return reply(base, { error = "Too-Many-Price-Batches" }, outbox)
  end
  return reply(base, { credited = amount, account = who, balance = Beacon.balances[who] }, withDust({}))
end

H["Withdraw"] = function(base, msg, from)
  if not from then return fail(base, "Unsigned") end
  local bal = int(Beacon.balances[from], 0)
  local amount = bal
  if msg.Quantity ~= nil then
    amount = int(msg.Quantity, nil)
    if not amount then return fail(base, "Bad-Quantity", from) end
  end
  if amount <= 0 or amount > bal then return fail(base, "Insufficient-Balance", from) end
  rng.purseWithdraw(purseOf(from), amount)
  Beacon.balances[from] = bal - amount
  return reply(base, { withdrawn = amount }, { ["rng-withdraw"] = transferOut(from, amount, "RNG balance withdrawal") })
end

local function finalize(base, r, sig, signers, now)
  local value = rng.hex(rng.sha256("hyperbeam/rng/v1/round|" .. roundMessage(r) .. "|" .. sig))
  local key = tostring(r)
  Beacon.round, Beacon.lastRoundAt = r, now
  Beacon.rounds[key] = { signature = sig, value = value, signers = signers, derivation = REQUEST_DERIVATION }
  Beacon.rounds[tostring(r - ROUND_HISTORY)] = nil
  Beacon.attest[key] = nil
  Beacon.lockedRound, Beacon.lockedAt = 0, 0
  Beacon.partials = { round = 0, by = {} }

  local byRequester, order, served, requests = {}, {}, 0, {}
  -- Only members still on the committee are paid: one that left by the exit
  -- hatch is paid nothing for the round it was in (its share goes to the rest).
  local paid = {}
  for _, s in ipairs(signers) do if Beacon.committee[s] then paid[#paid + 1] = s end end
  local n = #paid
  for _, p in ipairs(Beacon.pending[key] or {}) do
    local v = requestValue(value, p.requester, p.requestId)
    requests[#requests + 1] = { requester = p.requester, requestId = p.requestId, value = v }
    if p.process then
      local out = byRequester[p.requester]
      if not out then
        out = {}
        byRequester[p.requester] = out
        order[#order + 1] = p.requester
      end
      out[#out + 1] = { requestId = p.requestId, round = r, value = v }
    end
    -- Pay out exactly what this request was charged: the protocol's share as
    -- recorded, the rest split between this round's signers (any remainder to
    -- the protocol), whatever the fees or the threshold are now.
    local charged, protocol = int(p.charged, 0), int(p.protocol, 0)
    local each = n > 0 and (charged - protocol) // n or 0
    for _, s in ipairs(paid) do add(Beacon.accrued, s, each) end
    Beacon.protocolAccrued = int(Beacon.protocolAccrued, 0) + charged - each * n
    served = served + 1
  end
  local outbox = {}
  for i, requester in ipairs(order) do
    outbox["rng-result-" .. i] = { target = requester, Action = "RNG-Result",
      Data = encode({ round = r, signature = sig, derivation = REQUEST_DERIVATION, results = byRequester[requester] }) }
  end
  Beacon.pending[key] = nil
  Beacon.pendingCount = int(Beacon.pendingCount, 0) - served
  -- This slot's record: checkable on its own (BLS-verify `signature` on
  -- `message` under `groupKey`; value = H(round | message | signature); each
  -- request's value = H(derivation | value | requester | requestId)), and readable later at
  -- compute&slot=<slot>/beaconround.
  Finalized = { round = r, message = roundMessage(r), signature = sig, value = value,
    derivation = REQUEST_DERIVATION, signers = signers, groupKey = Beacon.groupKey, finalizedAt = now, slot = Slot, requests = requests }
  HistoryNew[#HistoryNew + 1] = { r, Slot }
  return reply(base, { round = r, served = served, value = value }, outbox)
end

--- Run before every handler: forget request ids past their guard, and
--- abandon the open round once past abandonAt (requests refunded, signers
--- unpaid). Its number is kept (the next requests bind to it again) unless
--- the round had locked: a BLS signature on a fixed message is
--- deterministic and published partials may already reveal it, so a locked
--- number is skipped and never carries a value.
local function advance(now)
  local q, expired = Beacon.seenQueue, 0
  while expired < #q and int(q[expired + 1][2], 0) < now do expired = expired + 1 end
  if expired > 0 then
    for i = 1, expired do Beacon.seen[q[i][1]] = nil end
    local n = #q
    for i = 1, n - expired do q[i] = q[i + expired] end
    for i = n, n - expired + 1, -1 do q[i] = nil end
  end
  local r = int(Beacon.round, 0) + 1
  local due = abandonAt(r)
  if not due or now < due then return end
  local key = tostring(r)
  local refunded = {}
  for _, p in ipairs(refundPending(r)) do refunded[#refunded + 1] = { requester = p.requester, requestId = p.requestId } end
  local skipped = int(Beacon.lockedRound, 0) == r
  if skipped then Beacon.round = r end
  Beacon.attest[key] = nil
  Beacon.lockedRound, Beacon.lockedAt = 0, 0
  Beacon.partials = { round = 0, by = {} }
  Abandoned = { { round = r, skipped = skipped, abandonedAt = now, slot = Slot, refunded = refunded } }
  HistoryNew[#HistoryNew + 1] = { r, Slot, "abandoned" }
end

--- Only a round that requests wait for is signed: there is no heartbeat.
H["Round"] = function(base, msg, from, now)
  -- Committee members post with their own wallets: a real signature, never a
  -- process delivery.
  local member = provenSigner(msg)
  if not member or not Beacon.committee[member] then return fail(base, "Not a committee member") end
  local data = dataOf(msg)
  local r, sig = int(data.round, nil), data.signature
  if r ~= int(Beacon.round, 0) + 1 or type(sig) ~= "string" or sig == "" or #sig > 512 then
    return fail(base, "Bad-Round")
  end
  local key = tostring(r)
  if #(Beacon.pending[key] or {}) == 0 then return fail(base, "Nothing-Pending") end
  if int(Beacon.lockedRound, 0) == 0 then Beacon.lockedRound, Beacon.lockedAt = r, now end

  if Beacon.verification == "device" then
    local signers = partialSigners(r)
    if #signers < int(Beacon.threshold, 0) then return fail(base, "Not-Enough-Partials") end
    local valid, why = verifyWithDevice(r, sig)
    if not valid then return fail(base, why) end
    return finalize(base, r, sig, signers, now)
  end
  local byRound = Beacon.attest[key] or { by = {}, sigs = {} }
  Beacon.attest[key] = byRound
  local prior = byRound.by[member]
  if prior then
    if prior ~= sig then add(Beacon.equivocations, member, 1) end
    return reply(base, { attested = false, reason = "already attested" })
  end
  byRound.by[member] = sig
  local list = byRound.sigs[sig] or {}
  list[#list + 1] = member
  byRound.sigs[sig] = list
  if #list < int(Beacon.threshold, 2) then return reply(base, { attested = true, count = #list }) end
  return finalize(base, r, sig, list, now)
end

--- A member's partial signature for the open round, published for the
--- other members to combine. Not checked here (no pairing in Lua); members
--- verify each partial against its share key before using it.
H["Partial"] = function(base, msg, from, now)
  local member = provenSigner(msg)
  if not member or not Beacon.committee[member] then return fail(base, "Not a committee member") end
  local data = dataOf(msg)
  local r, sig = int(data.round, nil), data.signature
  if r ~= int(Beacon.round, 0) + 1 or type(sig) ~= "string" or sig == "" or #sig > 512 then
    return fail(base, "Bad-Round")
  end
  local key = tostring(r)
  if #(Beacon.pending[key] or {}) == 0 then return fail(base, "Nothing-Pending") end
  if Beacon.verification == "device" then
    local publicKey = Beacon.sharePublicKeys[member]
    local valid, why = verifySignature(publicKey, roundMessage(r), sig)
    if not valid then return fail(base, why) end
  end
  if int(Beacon.lockedRound, 0) == 0 then Beacon.lockedRound, Beacon.lockedAt = r, now end
  if int(Beacon.partials.round, 0) ~= r then Beacon.partials = { round = r, by = {} } end
  Beacon.partials.by[member] = sig
  return reply(base, { round = r, partials = count(Beacon.partials.by) })
end

--- A signer's own earnings, to its own wallet. Nobody else, governance
--- included, can claim them.
H["Claim"] = function(base, msg, from)
  if not from or FromProcess then return fail(base, "Nothing-To-Claim") end
  local amount = int(Beacon.accrued[from], 0)
  if amount <= 0 then return fail(base, "Nothing-To-Claim") end
  Beacon.accrued[from] = 0
  return reply(base, { claimed = amount }, { ["rng-claim"] = transferOut(from, amount, "RNG fast-tier signer fees") })
end

--- The exit hatch: while a passed money or code action waits for its
--- Effective-At, a member leaves the committee at once, with its earnings.
--- The fast tier holds no bond. Rounds it would have signed need the others:
--- with fewer than `threshold` left they are abandoned and refunded by the
--- usual rule.
H["Exit-Now"] = function(base, msg, from, now)
  local member = provenSigner(msg)
  if not member or FromProcess or not Beacon.committee[member] then return fail(base, "Not a committee member") end
  if now <= 0 then return fail(base, "No-Time") end
  if not Gov.hatchOpen(Gov.queueOf(Beacon.gov), now) then return fail(base, "Hatch-Closed") end
  Beacon.committee[member], Beacon.sharePublicKeys[member] = nil, nil
  local amount, outbox = int(Beacon.accrued[member], 0), {}
  if amount > 0 then
    Beacon.accrued[member] = 0
    outbox["rng-claim"] = transferOut(member, amount, "RNG fast-tier signer fees: exit hatch")
  end
  return reply(base, { exited = true, claimed = amount, committee = count(Beacon.committee) }, outbox)
end

H["Get-Info"] = function(base) return reply(base, info()) end

H["Get-Round"] = function(base, msg)
  local r = int(msg.Round or msg.round, Beacon.round)
  local round = Beacon.rounds[tostring(r)]
  if not round then
    -- Older rounds are read at their slot (`beaconhistory`, deploy/README.md).
    for i = #Beacon.history, 1, -1 do
      local e = Beacon.history[i]
      if int(e[1], 0) == r then
        return reply(base, { error = "Round-Not-Retained", round = r, slot = e[2], abandoned = e[3] == "abandoned" })
      end
    end
    return fail(base, "Round-Not-Found")
  end
  return reply(base, { round = r, signature = round.signature, value = round.value, signers = round.signers })
end

H["Balance"] = function(base, msg, from)
  local who = msg.Account or from
  return reply(base, { account = who, balance = int(Beacon.balances[who], 0), accrued = int(Beacon.accrued[who], 0) })
end

---------------------------------------------------------------------------
-- Governance: the launch wallet and the DAO, equal owners (vendor/gov.lua)
---------------------------------------------------------------------------

--- Which owner sent the current message: "wallet", "dao" or nil
--- (gov.lua's Gov.ownerOf over the verified body; set by compute).
local Who = nil

--- The DAO process, believed only as a from-process our scheduler attested.
local function isGovernor() return Who == "dao" end
--- The DAO executes a proposal once: true when this DAO's proposal
--- already ran (a redelivery), else records it. The last EXECUTED_KEEP are
--- remembered; a numeric id at or below the highest one pruned also counts as
--- run. A redelivery follows its first copy closely, and a DAO proposal is
--- executed within days of its vote, so one older than EXECUTED_KEEP later
--- executions is a replay: refusing it is the safe direction.
local function executedBefore(g, from, proposal)
  g.executed, g.executedOrder = g.executed or {}, g.executedOrder or {}
  local key = from .. "|" .. tostring(proposal)
  local n = int(proposal, nil)
  if g.executed[key] or (n and n <= int(g.executedFloor, 0)) then return true end
  local order = g.executedOrder
  while #order >= EXECUTED_KEEP do
    local gone = table.remove(order, 1)
    g.executed[gone] = nil
    local pruned = int(tostring(gone):match("|(.*)$"), nil)
    if pruned and pruned > int(g.executedFloor, 0) then g.executedFloor = pruned end
  end
  g.executed[key] = true
  order[#order + 1] = key
  return false
end

--- The launch wallet, until Gov.Renounce-Wallet switches it off for good.
local function isDeployer() return Who == "wallet" end
local function govOnly() return Who ~= nil end

--- Governance arguments are tags ("Signer-Fee", "signer_fee" or "signerfee"
--- all name signerFee). Only the wallet's message may give them in Data
--- (JSON) instead, where no tag gives them.
local function norm(k) return (tostring(k):lower():gsub("[%-_]", "")) end
local function govArgs(msg)
  local data = {}
  if isDeployer() then for k, v in pairs(dataOf(msg)) do data[norm(k)] = v end end
  return function(name)
    local dashed = (name:gsub("(%u)", "-%1"):gsub("^%-", ""))
    for _, n in ipairs({ dashed, (dashed:gsub("%-", "_")), name:lower() }) do
      local v = msg[n]
      if v ~= nil then return v end
    end
    return data[norm(name)]
  end
end

--- A list argument: a table (deployer Data) or a JSON array tag.
local function listArg(v)
  if type(v) == "string" then
    local ok, d = pcall(json.decode, v)
    v = ok and d or nil
  end
  return type(v) == "table" and v or nil
end

--- The committee a Gov.Configure names, checked whole: { committee,
--- sharePublicKeys, groupKey, threshold, verification }, whether it differs
--- from the current one, or nil and why.
local function committeeFrom(arg)
  local c = {
    committee = Beacon.committee, sharePublicKeys = Beacon.sharePublicKeys, groupKey = Beacon.groupKey,
    threshold = Beacon.threshold, verification = Beacon.verification,
  }
  local changed = false
  local list = arg("committee")
  if list ~= nil then
    list = listArg(list)
    if not list or #list == 0 then return nil, "Invalid-Committee" end
    c.committee = {}
    for i, address in ipairs(list) do
      if not isAoAddress(address) or c.committee[address] then return nil, "Invalid-Committee" end
      c.committee[address] = i
    end
    c.sharePublicKeys = {}
    changed = true
  end
  local keys = arg("sharePublicKeys")
  if keys ~= nil then
    keys = listArg(keys)
    if not keys then return nil, "Invalid-Share-Public-Keys" end
    c.sharePublicKeys = {}
    for address, index in pairs(c.committee) do
      local publicKey = keys[index]
      if type(publicKey) ~= "string" or #publicKey ~= 96 or publicKey:match("^[%da-fA-F]+$") == nil then
        return nil, "Invalid-Share-Public-Keys"
      end
      c.sharePublicKeys[address] = publicKey:lower()
    end
    changed = true
  end
  local groupKey = arg("groupKey")
  if groupKey ~= nil then
    if type(groupKey) ~= "string" or #groupKey ~= 96 or groupKey:match("^[%da-fA-F]+$") == nil then
      return nil, "Invalid-Group-Key"
    end
    c.groupKey, changed = groupKey:lower(), true
  end
  local threshold = arg("threshold")
  if threshold ~= nil then
    c.threshold = int(threshold, nil)
    if not c.threshold then return nil, "Invalid-Threshold" end
    changed = true
  end
  local verification = arg("verification")
  if verification ~= nil then
    if verification ~= "attestations" and verification ~= "device" then return nil, "Invalid-Verification" end
    c.verification, changed = verification, true
  end
  local size = count(c.committee)
  if c.groupKey == "" then return nil, "Invalid-Group-Key" end
  if size == 0 or c.threshold < 1 or c.threshold > size then return nil, "Invalid-Threshold" end
  -- With more than one member, one key alone is never a quorum.
  if size > 1 and c.threshold < 2 then return nil, "Invalid-Threshold" end
  if c.verification == "device" then
    for address in pairs(c.committee) do
      if not c.sharePublicKeys[address] then return nil, "Invalid-Share-Public-Keys" end
    end
  end
  return c, nil, changed
end

local function applyCommittee(c)
  Beacon.committee, Beacon.sharePublicKeys, Beacon.groupKey = c.committee, c.sharePublicKeys, c.groupKey
  Beacon.threshold, Beacon.verification = c.threshold, c.verification
  -- The open round restarts under the new key: its old partials and
  -- attestations no longer count. Its requests stay bound to it.
  Beacon.partials, Beacon.attest, Beacon.lockedRound, Beacon.lockedAt = { round = 0, by = {} }, {}, 0, 0
end

--- The first Gov.Configure that names the token is genesis: token, unit and
--- self are fixed from then on, and the whole committee applies at once.
--- After genesis everything applies at once too: fees (a request pays the
--- price of the moment it is made) and a committee change (members, keys,
--- threshold, verification), which needs a new DKG ceremony first.
H["Gov.Configure"] = function(base, msg)
  if not govOnly() then return fail(base, "Not authorised") end
  local arg = govArgs(msg)
  local genesis = Beacon.token == ""
  local token, self, unit = arg("token"), arg("self"), arg("unit")
  if not genesis then
    if (token ~= nil and tostring(token) ~= Beacon.token) or (self ~= nil and tostring(self) ~= Beacon.self)
       or (unit ~= nil and int(unit, 0) ~= Beacon.unit) then
      return fail(base, "Token-Locked")
    end
  else
    if not isAoAddress(token) then return fail(base, "Invalid-Token") end
    if not isAoAddress(self) then return fail(base, "Invalid-Self") end
    if unit ~= nil and int(unit, 0) < 1 then return fail(base, "Invalid-Unit") end
  end
  local fees = { signerFee = Beacon.signerFee, protocolFee = Beacon.protocolFee }
  for k in pairs(fees) do
    local v = arg(k)
    if v ~= nil then
      fees[k] = int(v, nil)
      if not fees[k] or fees[k] < 1 or fees[k] > MAX_FEE then return fail(base, "Bad-Parameter") end
    end
  end
  -- It only sets how long requests wait before their refund.
  local abandonAfter = arg("abandonAfterMs")
  if abandonAfter ~= nil then
    abandonAfter = int(abandonAfter, nil)
    if not abandonAfter or abandonAfter < 60000 or abandonAfter > ABANDON_CAP_MS then return fail(base, "Bad-Parameter") end
  end
  local c, why, changed = committeeFrom(arg)
  if not c then return fail(base, why) end
  Beacon.signerFee, Beacon.protocolFee = fees.signerFee, fees.protocolFee
  if abandonAfter then Beacon.abandonAfterMs = abandonAfter end
  if genesis then
    Beacon.token, Beacon.self = token, self
    if unit ~= nil then Beacon.unit = int(unit, Beacon.unit) end
  end
  if genesis or changed then applyCommittee(c) end
  local out = info()
  out.ok = true
  return reply(base, out)
end

--- The protocol's fee share, all of it, to a recipient. Never to the DAO,
--- this process or the token (atoms there are stranded or recycled).
H["Gov.Claim-Protocol"] = function(base, msg)
  if not govOnly() then return fail(base, "Not authorised") end
  local to = govArgs(msg)("recipient")
  if not isAoAddress(to) or to == GovState.dao or to == Beacon.self or to == Beacon.token then
    return fail(base, "Bad-Recipient")
  end
  local amount, outbox = int(Beacon.protocolAccrued, 0), {}
  if amount > 0 then
    Beacon.protocolAccrued = 0
    outbox["rng-protocol"] = transferOut(to, amount, "RNG fast-tier protocol fees")
  end
  return reply(base, { claimed = amount, recipient = to }, outbox)
end

--- No new requests. Requests already bound are still signed and paid.
H["Gov.Pause"] = function(base)
  if not govOnly() then return fail(base, "Not authorised") end
  Beacon.paused = true
  return reply(base, { paused = true })
end

H["Gov.Resume"] = function(base)
  if not govOnly() then return fail(base, "Not authorised") end
  Beacon.paused = false
  return reply(base, { paused = false })
end

--- gov.lua's verbs (Gov.Set-Dao, Gov.Renounce-Wallet, Gov.Approve-Code,
--- Gov.Upgrade), over the request as the node delivered it.
local Req = nil
local function govVerb(base)
  Gov.handle(base, Req)
  return base
end
for _, verb in ipairs({ "Gov.Set-Dao", "Gov.Renounce-Wallet", "Gov.Approve-Code", "Gov.Upgrade" }) do H[verb] = govVerb end
-- gov.lua replies with output only; compute adds this message's notices.
Gov.reply = function(base, t)
  Gov.DEFAULT.reply(base, t)
  base.results.outbox = {}
end

--- MONEY/CODE: the committee (who signs, and so who can predict a value),
--- the protocol's fee share, the DAO seat, and code (gov.lua's). They wait
--- for an Effective-At >= receipt + Gov.EXIT_FLOOR_MS. Fees (bounded by
--- MAX_FEE), abandonAfterMs, Pause and Resume are harmless: on receipt.
local MONEY_VERBS = { ["Gov.Claim-Protocol"] = true, ["Gov.Set-Dao"] = true }
local SCHEDULED = { ["Gov.Configure"] = true, ["Gov.Pause"] = true, ["Gov.Resume"] = true,
  ["Gov.Claim-Protocol"] = true, ["Gov.Set-Dao"] = true }
local COMMITTEE_ARGS = { "committee", "sharePublicKeys", "groupKey", "threshold", "verification" }

local function govClass(verb, msg)
  if MONEY_VERBS[verb] then return "money" end
  if verb ~= "Gov.Configure" then return "harmless" end
  if Beacon.token == "" then return "money" end
  local arg = govArgs(msg)
  for _, k in ipairs(COMMITTEE_ARGS) do if arg(k) ~= nil then return "money" end end
  return "harmless"
end

local function govQueue() return Gov.queueOf(Beacon.gov) end
-- Gov.Renounce-Wallet is refused while this queue holds an action.
Gov.queue = govQueue

local function applyVerb(base, verb, msg, from, now)
  if verb == "Gov.Set-Dao" then
    local dao = govArgs(msg)("dao")
    if not isAoAddress(dao) then return fail(base, "Dao must be a 43-character process id") end
    GovState.dao = dao
    return reply(base, { ok = true, dao = dao })
  end
  return H[verb](base, msg, from, now)
end

local function replyData(res)
  local ok, v = pcall(json.decode, res and res.results and res.results.output and res.results.output.data or "")
  return ok and type(v) == "table" and v or {}
end

local MAX_ARGS_BYTES = 4096
local ENVELOPE, caseInsensitive -- set with the entry point, below
local function argsOf(msg)
  local args, bytes, names = {}, 0, {}
  for k, v in pairs(msg) do
    local key = tostring(k):lower()
    if type(v) == "string" and not ENVELOPE[key] and key ~= "data" and key ~= "effective-at"
       and key ~= "x-dao-proposal" then
      args[k], bytes = v, bytes + #tostring(k) + #v
      names[#names + 1] = k
    end
  end
  table.sort(names)
  local parts = {}
  for _, k in ipairs(names) do if tostring(k):lower() ~= "action" then parts[#parts + 1] = k .. "=" .. args[k] end end
  return args, bytes, table.concat(parts, " "):sub(1, 256)
end

--- A DAO message for a SCHEDULED verb (anyhonest.lua's rule): harmless with
--- no later Effective-At applies now; otherwise it is checked on a copy of
--- the state, then its Effective-At, then stored for Gov.Apply.
local function propose(base, verb, msg, from, now)
  local class = govClass(verb, msg)
  local v = msg["Effective-At"]
  if class == "harmless" and (v == nil or int(v, 0) <= now) then return applyVerb(base, verb, msg, from, now) end
  local real = Beacon
  Beacon = deepCopy(real)
  GovState = Beacon.owners
  local ok, res = pcall(applyVerb, base, verb, msg, from, now)
  Beacon, GovState = real, real.owners
  if not ok then error(res, 0) end
  local out = replyData(res)
  if out.error then return fail(base, out.error) end
  local at, why = Gov.when(msg, class, now)
  if not at then
    return reply(base, { error = why, class = class, earliest = class == "money" and now + Gov.EXIT_FLOOR_MS or nil })
  end
  local args, bytes, summary = argsOf(msg)
  if bytes > MAX_ARGS_BYTES then return fail(base, "Too-Large") end
  local e, err = Gov.schedule(govQueue(), { verb = verb, class = class, effectiveAt = at, args = args,
    summary = verb .. (summary ~= "" and (" " .. summary) or "") }, now)
  if not e then return fail(base, err) end
  return reply(base, { pending = { id = e.id, verb = verb, class = class, effectiveAt = at } })
end

--- Anyone: applies a pending action once due (bounds checked again now). A
--- refusal leaves it pending; a lapsed one is dropped.
H["Gov.Apply"] = function(base, msg, from, now)
  local q = govQueue()
  local e, key = Gov.due(q, govArgs(msg)("govId"), now)
  if not e then return fail(base, key) end
  local saved = Who
  Who = "dao"
  local ok, res = pcall(applyVerb, base, e.verb, caseInsensitive(e.args), nil, now)
  Who = saved
  if not ok then error(res, 0) end
  local out = replyData(res)
  -- Refused: it stays pending but no longer holds the exit hatch open.
  if out.error then e.refused = true; return reply(base, { error = out.error, govId = e.id, verb = e.verb }) end
  q.pending[key] = nil
  out.applied, out.verb = e.id, e.verb
  return reply(base, out, res.results.outbox)
end

--- An owner drops a pending action at once (Gov-Id "code": the code approval).
H["Gov.Cancel"] = function(base, msg)
  if not govOnly() then return fail(base, "Not authorised") end
  local id = govArgs(msg)("govId")
  if tostring(id):lower() == "code" then
    if not Gov.cancelCode() then return fail(base, "Unknown-Gov-Id") end
    return reply(base, { cancelled = "code" })
  end
  local n = int(id, nil)
  local key = n and string.format("%d", n) or ""
  if not govQueue().pending[key] then return fail(base, "Unknown-Gov-Id") end
  govQueue().pending[key] = nil
  return reply(base, { cancelled = n })
end

---------------------------------------------------------------------------
-- Entry point
---------------------------------------------------------------------------

ENVELOPE = {
  target = true, id = true, owner = true, signature = true, anchor = true,
  commitments = true, from = true, type = true, variant = true,
  path = true, method = true, slot = true, device = true, nonce = true,
  epoch = true, accept = true, scheduler = true, subject = true,
  ["from-process"] = true, ["data-protocol"] = true, ["content-type"] = true,
  ["accept-bundle"] = true, ["random-seed"] = true, ["hashpath"] = true,
  fromprocess = true, tags = true,
}

--- The message as handlers see it. Envelope fields (commitments,
--- from-process) come only from the body the node verified; a `Tags` table
--- adds tags but never replaces the body or an envelope field.
function caseInsensitive(raw)
  local t, named = {}, {}
  for k, v in pairs(raw) do if k ~= "Tags" then t[k] = v; named[tostring(k):lower()] = true end end
  -- A tag never shadows a body field in another case: the node's body keys
  -- are lowercase ("quantity"), and a "Quantity" tag would otherwise win.
  if type(raw.Tags) == "table" then
    for k, v in pairs(raw.Tags) do
      local key = tostring(k):lower()
      if not named[key] and not ENVELOPE[key] then t[k] = v; named[key] = true end
    end
  end
  local lower = {}
  for k, v in pairs(t) do
    local key = tostring(k):lower()
    if not ENVELOPE[key] then lower[key] = v end
  end
  return setmetatable({}, {
    __index = function(_, key) return t[key] or lower[tostring(key):lower()] end,
    __pairs = function() return pairs(t) end,
  })
end

local ACTION_ALIASES, VERB_NAMES = nil, nil
--- The handler's own name for an action, in any spelling.
local function verbName(action)
  if H[action] then return action end
  if VERB_NAMES == nil then
    VERB_NAMES = {}
    for name in pairs(H) do VERB_NAMES[norm(name)] = name end
  end
  return VERB_NAMES[norm(action)]
end

local function resolveHandler(action)
  if H[action] then return H[action] end
  if ACTION_ALIASES == nil then
    ACTION_ALIASES = {}
    for name, fn in pairs(H) do ACTION_ALIASES[norm(name)] = fn end
  end
  -- Case, `-` and `_` folded: "Gov.SetDao" and "gov.set_dao" name Gov.Set-Dao.
  return ACTION_ALIASES[norm(action)]
end

function compute(base, req, opts)
  base = type(base) == "table" and base or {}
  bindOwners(restore(base))
  resolveOwner(base)
  local raw = (req and req.body) or {}
  Req, Who = req, nil
  local msg = caseInsensitive(type(raw) == "table" and raw or {})
  -- The scheduler's assignment time only; a Timestamp tag is the caller's word.
  local now = int(req and (req.timestamp or req.Timestamp), 0)
  Slot = int(req and (req.slot or (type(req.body) == "table" and req.body.slot)), nil)
  Now = now
  Notices, HistoryNew, Finalized, Abandoned = {}, {}, nil, nil
  local handler = resolveHandler(msg.Action or "none")
  local result
  local refused = TargetRefusal(raw, req)
  if refused then
    result = fail(base, refused)
  elseif not handler then
    result = fail(base, "unknown action '" .. tostring(msg.Action) .. "'")
  else
    local saved = deepCopy(Beacon)
    local ok, out = pcall(function()
      local from = actor(msg, base)
      Who = Gov.ownerOf(base, type(raw) == "table" and raw or nil)
      -- The DAO executes a proposal once: a redelivered Gov.* with the same
      -- X-Dao-Proposal from the DAO does nothing.
      local proposal = msg["X-Dao-Proposal"]
      if proposal ~= nil and tostring(msg.Action):lower():sub(1, 4) == "gov." and isGovernor() then
        if executedBefore(Beacon.gov, from, proposal) then
          return reply(base, { duplicate = true, proposal = tostring(proposal) })
        end
      end
      advance(now)
      Gov.prune(govQueue(), now)
      local verb = verbName(msg.Action or "none")
      -- Every Gov.* needs the scheduler's time, never older than the last.
      if tostring(verb):lower():sub(1, 4) == "gov." then
        local t, late = Gov.clock(now)
        if not t then return fail(base, late) end
      end
      if isGovernor() and SCHEDULED[verb] then return propose(base, verb, msg, from, now) end
      return handler(base, msg, from, now)
    end)
    if not ok then
      -- A handler that failed sends nothing, so it takes no sequence number,
      -- and leaves no half-applied state.
      Beacon = saved
      bindOwners(false)
      FromProcess = false
      Notices, HistoryNew, Finalized, Abandoned = {}, {}, nil, nil
    end
    result = ok and out or fail(base, tostring(out))
  end
  for k, v in pairs(Notices) do result.results.outbox[k] = v end
  for _, e in ipairs(HistoryNew) do rng.history(Beacon.history, e, HISTORY_KEEP) end
  if Finalized then result.beaconround = encode(Finalized) end
  if Abandoned then result.beaconabandoned = encode(Abandoned) end
  Beacon.rev = int(Beacon.rev, 0) + 1
  local state = {}
  for k, v in pairs(Beacon) do if type(v) ~= "function" and k ~= "history" then state[k] = v end end
  result.beaconstate = encode(state)
  -- Round -> slot for the last HISTORY_KEEP rounds; rewritten only when it moves.
  if #HistoryNew > 0 or result.beaconhistory == nil then
    result.beaconhistory = encode({ keep = HISTORY_KEEP, rounds = Beacon.history })
  end
  result.beaconrev = string.format("%d", Beacon.rev)
  result.beaconinfo = encode(info())
  result.beaconpartials = encode(Beacon.partials)
  collectgarbage("collect")
  return result
end
