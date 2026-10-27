-- timelock.lua: the RNG time-lock beacon (tier `timelock`), SPEC.md §2.
--
-- Every active validator commits a fresh RSA modulus for the round; the
-- puzzle input is fixed by the round; once commits close each validator
-- reveals its output and one factor, checked on the node by timelock@1.0. A
-- withheld reveal is cracked by another validator (T squarings + Wesolowski
-- proof). The round value hashes every output, so one honest validator keeps
-- it unpredictable.
--
-- Rounds overlap: the next round takes commits as soon as the last one's
-- commits close, so a slow (cracked) round never holds up the ones after it.
-- With `heartbeat` on, rounds run whether or not anyone is waiting.
--
-- Native ~lua@5.3a contract, same conventions as beacon.lua. Bundled after
-- vendor/json.lua, vendor/jsonenc.lua and lib/rng.lua (global `rng`).

local json = require(".json")
local SIGNATURE_ALGS = { ["rsa-pss-sha512"] = true, ["rsa-pss-sha256"] = true }
local ROUND_HISTORY = 8      -- finalized round records kept in published state
local GUARD_ROUNDS = 600     -- how long duplicate guards remember (~10 min at 1 round/s)
local STRIKE_WINDOW = 3600   -- strikes count within this many rounds (~1 h)

local function freshState()
  return {
    rev = 0, self = "", token = "", unit = 1000000,
    params = {
      T = 134217728, modulusBits = 2048, commitWindowMs = 3000, revealWindowMs = 10000,
      minCommits = 2, cadenceMs = 1000, suspendAfter = 3,
      slash = 1000, rejoinAfter = 600, heartbeat = 1,
    },
    -- address -> { strikes = { round, ... }, missed = n, suspended = bool, idle = bool, suspendedAt = round }
    validators = {},
    bonds = {},            -- address -> RNG bonded; each suspension takes `slash` of it
    round = 0,             -- highest finalized round
    lastRoundAt = 0,
    lastOpenAt = 0,        -- first commit of the newest round; cadence counts from here
    next = 1,              -- the round taking requests and commits
    opens = {},            -- "r" -> round being built (see openRound): `next`, plus older ones revealing
    recent = {},           -- finalized round numbers, oldest first (cracked rounds finish late)
    pending = {},          -- "r" -> list of { requester, requestId, charged }
    rounds = {},           -- "r" -> finalized record
    balances = {}, accrued = {}, protocolAccrued = 0,
    seen = {}, credited = {},
  }
end
Timelock = Timelock or freshState()

local function int(v, d)
  if v == nil then return d end
  local n = tonumber(v)
  return n and math.tointeger(n) or d
end

local function deflate(v)
  if type(v) == "number" then return math.tointeger(v) or v end
  if type(v) ~= "table" then return v end
  for k, x in pairs(v) do v[k] = deflate(x) end
  return v
end

local function restore(base)
  if int(base.timelockrev, 0) <= int(Timelock.rev, 0) then return end
  local ok, saved = pcall(json.decode, base.timelockstate or "")
  if ok and type(saved) == "table" then
    Timelock = freshState()
    for k, v in pairs(deflate(saved)) do Timelock[k] = v end
  end
end

---------------------------------------------------------------------------
-- Identity (paralith-mono conventions)
---------------------------------------------------------------------------

local function provenSigner(msg)
  local c = msg.commitments or msg.Commitments
  if type(c) ~= "table" then return nil end
  for _, commitment in pairs(c) do
    if type(commitment) == "table" and commitment.committer and SIGNATURE_ALGS[commitment.type or commitment.alg] then
      return commitment.committer
    end
  end
  return nil
end

local function schedulerAddress(base)
  local found = base["scheduler-location"]
  if type(found) == "string" and #found == 43 then return found end
  local p = base.process
  if type(p) == "table" and type(p["scheduler-location"]) == "string" then return p["scheduler-location"] end
  return nil
end

local function actor(msg, base)
  local signed = provenSigner(msg)
  local fromProcess = msg["from-process"] or msg.FromProcess
  if signed then
    if fromProcess and signed == schedulerAddress(base) then return fromProcess end
    return signed
  end
  local c = msg.commitments or msg.Commitments
  if type(c) == "table" and next(c) ~= nil then return nil end
  return fromProcess
end

local function isAoAddress(s) return type(s) == "string" and #s == 43 and s:match("^[%w_%-]+$") ~= nil end

local function resolveOwner(base)
  if Owner and Owner ~= "" then return Owner end
  local p = base.process
  local c = type(p) == "table" and p.commitments or nil
  if type(c) == "table" then
    for _, commitment in pairs(c) do
      if type(commitment) == "table" and commitment.committer and SIGNATURE_ALGS[commitment.type or commitment.alg] then
        Owner = commitment.committer
        return Owner
      end
    end
  end
  return Owner
end

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

local function reply(base, value, outbox)
  base.results = { output = { data = type(value) == "string" and value or encode(value) }, outbox = outbox or {} }
  return base
end

local function fail(base, message, to, extra)
  local outbox = {}
  if to then
    local data = { error = message }
    for k, v in pairs(extra or {}) do data[k] = v end
    outbox["rng-error"] = { target = to, Action = "RNG-Error", Data = encode(data) }
  end
  return reply(base, { error = message }, outbox)
end

local function dataOf(msg)
  local d = msg.Data or msg.data
  if type(d) == "string" then
    local ok, v = pcall(json.decode, d)
    d = ok and v or nil
  end
  return type(d) == "table" and deflate(d) or {}
end

local function add(map, key, n) map[key] = int(map[key], 0) + n end

local function activeValidators()
  local out = {}
  for addr, v in pairs(Timelock.validators) do if not v.suspended then out[#out + 1] = addr end end
  table.sort(out)
  return out
end

local function price() return #activeValidators() + 1 end

local function seedFor(r, addr) return Timelock.self .. "|" .. tostring(r) .. "|" .. addr end

local function isHex(s, maxLen)
  return type(s) == "string" and #s > 0 and #s <= maxLen and s:match("^[0-9a-f]+$") ~= nil and s:sub(1, 1) ~= "0"
end

--- A modulus of exactly modulusBits bits, as lowercase hex.
local function isModulus(s)
  local bits = int(Timelock.params.modulusBits, 2048)
  if not isHex(s, bits // 4) or #s ~= bits // 4 then return false end
  return tonumber(s:sub(1, 1), 16) >= 8
end

--- Ask timelock@1.0; any failure to reach it is a no.
--- Tests set the global RngDeviceResolve in place of ao.resolve.
local function device(key, inputs)
  local resolve = RngDeviceResolve or (type(ao) == "table" and ao.resolve)
  if type(resolve) ~= "function" then return false end
  inputs.path = "/~timelock@1.0/" .. key
  local ok, status, res = pcall(resolve, inputs)
  return ok and status == "ok" and type(res) == "table" and (res.valid == true or res.valid == "true")
end

local function strike(addr, r)
  local v = Timelock.validators[addr]
  if not v then return end
  v.strikes = v.strikes or {}
  v.strikes[#v.strikes + 1] = r
  local recent = {}
  for _, s in ipairs(v.strikes) do if int(s, 0) > r - STRIKE_WINDOW then recent[#recent + 1] = s end end
  v.strikes = recent
  if #recent >= int(Timelock.params.suspendAfter, 3) and not v.suspended then
    -- Suspension costs `slash` from the bond, paid to the protocol.
    local cut = math.min(int(Timelock.params.slash, 1000), int(Timelock.bonds[addr], 0))
    Timelock.bonds[addr] = int(Timelock.bonds[addr], 0) - cut
    Timelock.protocolAccrued = int(Timelock.protocolAccrued, 0) + cut
    v.suspended, v.idle, v.suspendedAt = true, false, r
  end
end

--- A missed commit costs nothing but the round's fee. `suspendAfter` in a
--- row makes the validator idle (suspended, no slash) so rounds stop waiting
--- out its commit window; it rejoins whenever it is back.
local function missed(addr, r)
  local v = Timelock.validators[addr]
  if not v then return end
  v.missed = int(v.missed, 0) + 1
  if v.missed >= int(Timelock.params.suspendAfter, 3) and not v.suspended then
    v.suspended, v.idle, v.suspendedAt = true, true, r
  end
end

local function openRound(r)
  return { round = r, phase = "collecting", firstCommitAt = 0, commitClose = 0, revealDeadline = 0,
           active = activeValidators(), commits = {}, outputs = {} }
end

local function count(t) local n = 0 for _ in pairs(t) do n = n + 1 end return n end

---------------------------------------------------------------------------
-- Round state machine
---------------------------------------------------------------------------

--- The round taking commits (always `collecting` or `commit`).
local function current()
  local key = tostring(Timelock.next)
  if not Timelock.opens[key] then Timelock.opens[key] = openRound(Timelock.next) end
  return Timelock.opens[key]
end

local function closeCommits(o, now)
  o.phase = "reveal"
  o.commitClose = math.min(now, o.firstCommitAt + int(Timelock.params.commitWindowMs, 3000))
  o.revealDeadline = o.commitClose + int(Timelock.params.revealWindowMs, 10000)
  for _, addr in ipairs(o.active) do
    if not o.commits[addr] then missed(addr, o.round) end
  end
  if count(o.commits) < int(Timelock.params.minCommits, 2) then
    -- Void: requests stay on this round number; validators commit fresh moduli.
    Timelock.opens[tostring(o.round)] = openRound(o.round)
    return "void"
  end
  -- Reveals run from here; the next round takes commits alongside.
  Timelock.next = o.round + 1
  return "reveal"
end

local function finalize(base, o, now)
  local r, key = o.round, tostring(o.round)
  local addrs = {}
  for addr in pairs(o.commits) do addrs[#addrs + 1] = addr end
  table.sort(addrs)
  local ys = {}
  for _, addr in ipairs(addrs) do ys[#ys + 1] = o.outputs[addr].y end
  local value = rng.hex(rng.sha256("rng/timelock|" .. Timelock.self .. "|" .. key .. "|" .. table.concat(ys, "|")))

  local byRequester, order, served = {}, {}, 0
  local contributors = #addrs
  for _, p in ipairs(Timelock.pending[key] or {}) do
    local out = byRequester[p.requester]
    if not out then out = {}; byRequester[p.requester] = out; order[#order + 1] = p.requester end
    out[#out + 1] = { requestId = p.requestId, round = r, value = rng.hex(rng.sha256(value .. "|" .. p.requestId)) }
    served = served + 1
    -- Charged for every active validator at request time; only those whose
    -- output went into the value are paid, the rest goes back to the requester.
    local refund = int(p.charged, 0) - (contributors + 1)
    if refund > 0 then add(Timelock.balances, p.requester, refund) end
  end
  for _, addr in ipairs(addrs) do
    local out = o.outputs[addr]
    add(Timelock.accrued, out.via == "crack" and out.cracker or addr, served)
  end
  Timelock.protocolAccrued = int(Timelock.protocolAccrued, 0) + served

  local outbox = {}
  for i, requester in ipairs(order) do
    outbox["rng-result-" .. i] = { target = requester, Action = "RNG-Result",
      Data = encode({ round = r, tier = "timelock", value = value, results = byRequester[requester] }) }
  end
  Timelock.rounds[key] = { round = r, opened = o.firstCommitAt, commitClose = o.commitClose, finalizedAt = now,
    commits = o.commits, outputs = o.outputs, value = value, requests = served }
  local recent = Timelock.recent
  recent[#recent + 1] = r
  while #recent > ROUND_HISTORY do Timelock.rounds[tostring(table.remove(recent, 1))] = nil end
  Timelock.pending[key] = nil
  Timelock.opens[key] = nil
  Timelock.round, Timelock.lastRoundAt = math.max(int(Timelock.round, 0), r), now
  if r % 50 == 0 then
    for _, guard in ipairs({ Timelock.seen, Timelock.credited }) do
      for k, at in pairs(guard) do if int(at, 0) < r - GUARD_ROUNDS then guard[k] = nil end end
    end
  end
  return reply(base, { round = r, value = value, served = served }, outbox)
end

--- Close the committing round's commits once everyone is in or its window
--- has passed; called before every round action.
local function advance(now)
  local o = current()
  if o.phase == "commit" then
    local all = true
    for _, addr in ipairs(o.active) do if not o.commits[addr] then all = false end end
    if all or now >= o.firstCommitAt + int(Timelock.params.commitWindowMs, 3000) then return closeCommits(o, now) end
  end
  return o.phase
end

--- A round past its commits, by number.
local function revealing(r)
  local o = Timelock.opens[tostring(int(r, -1))]
  return o and o.phase == "reveal" and o or nil
end

local function complete(o)
  for addr in pairs(o.commits) do if not o.outputs[addr] then return false end end
  return true
end

---------------------------------------------------------------------------
-- Handlers: H[action](base, msg, from, now)
---------------------------------------------------------------------------

local H = {}

H["Credit-Notice"] = function(base, msg, from)
  if from ~= Timelock.token or Timelock.token == "" then return fail(base, "Not the configured token") end
  local key = from .. "|" .. tostring(msg.Reference or "")
  if msg.Reference and Timelock.credited[key] then return reply(base, { duplicate = true }) end
  local amount = int(msg.Quantity, 0) // int(Timelock.unit, 1)
  local who = msg["X-For"] or msg.Sender
  if amount <= 0 or not isAoAddress(who) then return fail(base, "Nothing to credit") end
  if msg.Reference then Timelock.credited[key] = Timelock.round end
  if msg["X-Bond"] then
    Timelock.bonds = Timelock.bonds or {}
    add(Timelock.bonds, who, amount)
    return reply(base, { bonded = amount, account = who, bond = Timelock.bonds[who] })
  end
  add(Timelock.balances, who, amount)
  return reply(base, { credited = amount, account = who, balance = Timelock.balances[who] }, {
    ["rng-funded"] = { target = who, Action = "RNG-Funded", Data = encode({ amount = amount, balance = Timelock.balances[who] }) },
  })
end

H["Withdraw"] = function(base, msg, from)
  if not from then return fail(base, "Unsigned") end
  local bal = int(Timelock.balances[from], 0)
  local amount = int(msg.Quantity, bal)
  if amount <= 0 or amount > bal then return fail(base, "Insufficient-Balance", from) end
  Timelock.balances[from] = bal - amount
  return reply(base, { withdrawn = amount }, { ["rng-withdraw"] = {
    target = Timelock.token, Action = "Transfer", Recipient = from,
    Quantity = string.format("%d", amount * int(Timelock.unit, 1)), ["X-Note"] = "RNG balance withdrawal" } })
end

H["Request-Random"] = function(base, msg, from, now)
  if not from then return fail(base, "Unsigned") end
  local requestId = msg["Request-Id"]
  local ctx = { requestId = requestId }
  if (msg.Tier or "timelock") ~= "timelock" then return fail(base, "Tier-Unavailable", from, ctx) end
  if type(requestId) ~= "string" or requestId == "" or #requestId > 128 then return fail(base, "Missing-Request-Id", from, ctx) end
  if #activeValidators() == 0 then return fail(base, "No-Validators", from, ctx) end
  local key = from .. "|" .. requestId
  if Timelock.seen[key] then return fail(base, "Duplicate-Request", from, ctx) end
  local cost = price()
  local bal = int(Timelock.balances[from], 0)
  if bal < cost then return fail(base, "Insufficient-Balance", from, { requestId = requestId, balance = bal, price = cost }) end
  advance(now)
  local o = current()
  -- Bind to a round whose commits have not started.
  local r = o.phase == "collecting" and o.round or o.round + 1
  Timelock.balances[from] = bal - cost
  Timelock.seen[key] = r
  local list = Timelock.pending[tostring(r)] or {}
  list[#list + 1] = { requester = from, requestId = requestId, charged = cost }
  Timelock.pending[tostring(r)] = list
  return reply(base, { requestId = requestId, round = r, price = cost, balance = Timelock.balances[from] })
end

local function validatorOf(msg)
  local addr = provenSigner(msg)
  local v = addr and Timelock.validators[addr]
  if not v or v.suspended then return nil end
  return addr
end

H["Commit"] = function(base, msg, from, now)
  local addr = validatorOf(msg)
  if not addr then return fail(base, "Not an active validator") end
  local d = dataOf(msg)
  advance(now)
  local o = current()
  if int(d.round, -1) ~= o.round then return fail(base, revealing(d.round) and "Commits-Closed" or "Wrong-Round") end
  if int(Timelock.params.heartbeat, 1) == 0 and #(Timelock.pending[tostring(o.round)] or {}) == 0 then
    return fail(base, "Nothing-Pending")
  end
  if o.phase == "collecting" and now < int(Timelock.lastOpenAt, 0) + int(Timelock.params.cadenceMs, 0) then
    return fail(base, "Too-Early")
  end
  -- The validator set is fixed when the round's first commit arrives.
  if o.phase == "collecting" then o.active = activeValidators() end
  local inSet = false
  for _, a in ipairs(o.active) do if a == addr then inSet = true end end
  if not inSet then return fail(base, "Joined-After-Round-Opened") end
  if o.commits[addr] then return fail(base, "Already-Committed") end
  if not isModulus(d.modulus) then return fail(base, "Bad-Modulus") end
  if o.phase == "collecting" then o.phase, o.firstCommitAt, Timelock.lastOpenAt = "commit", now, now end
  o.commits[addr] = d.modulus
  Timelock.validators[addr].missed = 0
  local phase = advance(now)
  return reply(base, { round = o.round, committed = count(o.commits), phase = phase })
end

H["Reveal"] = function(base, msg, from, now)
  local addr = provenSigner(msg)
  local d = dataOf(msg)
  advance(now)
  local o = revealing(d.round)
  if not o then return fail(base, "Not-Revealing") end
  if not addr or not o.commits[addr] then return fail(base, "Not-Committed") end
  if o.outputs[addr] then return fail(base, "Already-Revealed") end
  if not isHex(d.y, 1024) or not isHex(d.p, 1024) then return fail(base, "Bad-Reveal") end
  if not device("verify-reveal", { modulus = o.commits[addr], seed = seedFor(o.round, addr),
      t = tostring(int(Timelock.params.T, 0)), y = d.y, p = d.p }) then
    return fail(base, "Bad-Reveal")
  end
  o.outputs[addr] = { y = d.y, via = "reveal", p = d.p }
  if complete(o) then return finalize(base, o, now) end
  return reply(base, { round = o.round, revealed = count(o.outputs) })
end

H["Crack"] = function(base, msg, from, now)
  local cracker = validatorOf(msg)
  if not cracker then return fail(base, "Not an active validator") end
  local d = dataOf(msg)
  advance(now)
  local o = revealing(d.round)
  if not o then return fail(base, "Not-Revealing") end
  if now < o.revealDeadline then return fail(base, "Too-Early") end
  local target = d.validator
  if not o.commits[target] or o.outputs[target] then return fail(base, "Nothing-To-Crack") end
  if not isHex(d.y, 1024) or not isHex(d.proof, 1024) then return fail(base, "Bad-Crack") end
  if not device("verify-crack", { modulus = o.commits[target], seed = seedFor(o.round, target),
      t = tostring(int(Timelock.params.T, 0)), y = d.y, proof = d.proof }) then
    return fail(base, "Bad-Crack")
  end
  o.outputs[target] = { y = d.y, via = "crack", proof = d.proof, cracker = cracker }
  strike(target, o.round)
  if complete(o) then return finalize(base, o, now) end
  return reply(base, { round = o.round, cracked = target })
end

H["Claim"] = function(base, msg, from)
  local amount = int(from and Timelock.accrued[from], 0)
  if amount <= 0 then return fail(base, "Nothing-To-Claim") end
  Timelock.accrued[from] = 0
  return reply(base, { claimed = amount }, { ["rng-claim"] = {
    target = Timelock.token, Action = "Transfer", Recipient = from,
    Quantity = string.format("%d", amount * int(Timelock.unit, 1)), ["X-Note"] = "RNG validator fees" } })
end

local function ownerOnly(msg) return provenSigner(msg) == Owner end

--- A validator is active only while its bond covers the next slash.
local function bonded(a) return int(Timelock.bonds and Timelock.bonds[a], 0) >= int(Timelock.params.slash, 1000) end

H["Admin.Add-Validator"] = function(base, msg)
  if not ownerOnly(msg) then return fail(base, "Not authorised") end
  local a = dataOf(msg).address or msg.Address
  if not isAoAddress(a) then return fail(base, "Bad address") end
  -- Unbonded validators start idle and join with Rejoin once bonded.
  Timelock.validators[a] = Timelock.validators[a] or { strikes = {}, missed = 0, suspended = not bonded(a), idle = not bonded(a), suspendedAt = 0 }
  return reply(base, { validators = activeValidators() })
end

H["Admin.Remove-Validator"] = function(base, msg)
  if not ownerOnly(msg) then return fail(base, "Not authorised") end
  local a = dataOf(msg).address or msg.Address or ""
  Timelock.validators[a] = nil
  local bond = int(Timelock.bonds and Timelock.bonds[a], 0)
  if bond <= 0 then return reply(base, { validators = activeValidators() }) end
  Timelock.bonds[a] = nil
  return reply(base, { validators = activeValidators(), refunded = bond }, { ["rng-bond-refund"] = {
    target = Timelock.token, Action = "Transfer", Recipient = a,
    Quantity = string.format("%d", bond * int(Timelock.unit, 1)), ["X-Note"] = "RNG validator bond" } })
end

--- A suspended validator brings itself back while its bond still covers
--- another slash: an idle one at once, a slashed one `rejoinAfter` rounds on.
H["Rejoin"] = function(base, msg, from)
  local v = from and Timelock.validators[from]
  if not v then return fail(base, "Not a validator") end
  if not v.suspended then return fail(base, "Not suspended") end
  if not bonded(from) then return fail(base, "Bond-Too-Low") end
  if not v.idle then
    if Timelock.round < int(v.suspendedAt, 0) + int(Timelock.params.rejoinAfter, 600) then return fail(base, "Too-Soon") end
    v.strikes = {}
  end
  v.suspended, v.idle, v.missed = false, false, 0
  return reply(base, { validators = activeValidators(), bond = int(Timelock.bonds[from], 0) })
end

H["Admin.Reinstate"] = function(base, msg)
  if not ownerOnly(msg) then return fail(base, "Not authorised") end
  local v = Timelock.validators[dataOf(msg).address or msg.Address or ""]
  if not v then return fail(base, "Unknown validator") end
  v.suspended, v.idle, v.missed, v.strikes = false, false, 0, {}
  return reply(base, { validators = activeValidators() })
end

H["Claim-Protocol"] = function(base, msg)
  if not ownerOnly(msg) then return fail(base, "Not authorised") end
  local amount = int(Timelock.protocolAccrued, 0)
  if amount <= 0 then return fail(base, "Nothing-To-Claim") end
  Timelock.protocolAccrued = 0
  local to = isAoAddress(msg.Recipient) and msg.Recipient or Owner
  return reply(base, { claimed = amount }, { ["rng-claim"] = {
    target = Timelock.token, Action = "Transfer", Recipient = to,
    Quantity = string.format("%d", amount * int(Timelock.unit, 1)), ["X-Note"] = "RNG protocol fees" } })
end

H["Configure"] = function(base, msg)
  if not ownerOnly(msg) then return fail(base, "Not authorised") end
  local d = dataOf(msg)
  if d.self then Timelock.self = d.self end
  if d.token then Timelock.token = d.token end
  if d.unit then Timelock.unit = int(d.unit, Timelock.unit) end
  for k in pairs(Timelock.params) do
    if d[k] ~= nil then Timelock.params[k] = int(d[k], Timelock.params[k]) end
  end
  return reply(base, { ok = true })
end

H["Get-Info"] = function(base) return reply(base, { ok = true }) end

H["Balance"] = function(base, msg, from)
  local who = msg.Account or from
  return reply(base, { account = who, balance = int(Timelock.balances[who], 0), accrued = int(Timelock.accrued[who], 0) })
end

---------------------------------------------------------------------------
-- Entry point
---------------------------------------------------------------------------

local ENVELOPE = {
  target = true, id = true, owner = true, signature = true, anchor = true, commitments = true, from = true,
  type = true, variant = true, path = true, method = true, slot = true, device = true, nonce = true,
  epoch = true, accept = true, scheduler = true, subject = true, ["from-process"] = true,
  ["data-protocol"] = true, ["content-type"] = true, ["accept-bundle"] = true, ["random-seed"] = true, hashpath = true,
}

local function caseInsensitive(t)
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

local function resolveHandler(action)
  if H[action] then return H[action] end
  for name, fn in pairs(H) do if name:lower() == tostring(action):lower() then return fn end end
  return nil
end

local function info()
  local vs = {}
  for addr, v in pairs(Timelock.validators) do
    vs[#vs + 1] = { address = addr, suspended = v.suspended == true, idle = v.idle == true, strikes = #(v.strikes or {}),
                    missed = int(v.missed, 0), bond = int(Timelock.bonds and Timelock.bonds[addr], 0),
                    suspendedAt = int(v.suspendedAt, 0) }
  end
  table.sort(vs, function(a, b) return a.address < b.address end)
  local function roundInfo(o)
    local revealed = {}
    for addr in pairs(o.outputs or {}) do revealed[#revealed + 1] = addr end
    table.sort(revealed)
    return { round = o.round, phase = o.phase, pending = #(Timelock.pending[tostring(o.round)] or {}),
             firstCommitAt = o.firstCommitAt,
             commitDeadline = (o.firstCommitAt or 0) > 0 and o.firstCommitAt + Timelock.params.commitWindowMs or 0,
             revealDeadline = o.revealDeadline, active = o.active, committed = o.commits, revealed = revealed }
  end
  local older = {}
  for _, o in pairs(Timelock.opens) do if o.phase == "reveal" then older[#older + 1] = roundInfo(o) end end
  table.sort(older, function(a, b) return a.round < b.round end)
  local pendingTotal = 0
  for _, list in pairs(Timelock.pending) do pendingTotal = pendingTotal + #list end
  return {
    tier = "timelock", round = Timelock.round, params = Timelock.params, validators = vs,
    price = price(), token = Timelock.token, unit = Timelock.unit,
    nextRoundAt = int(Timelock.lastOpenAt, 0) + int(Timelock.params.cadenceMs, 0),
    open = roundInfo(current()), revealing = older,
    pendingCount = pendingTotal, protocolAccrued = Timelock.protocolAccrued, self = Timelock.self,
  }
end

function compute(base, req)
  base = type(base) == "table" and base or {}
  restore(base)
  resolveOwner(base)
  local raw = (req and req.body) or {}
  local msg = caseInsensitive(raw.Tags or raw)
  local now = int(req and (req.timestamp or req.Timestamp), 0)
  local handler = resolveHandler(msg.Action or "none")
  local result
  if not handler then
    result = fail(base, "unknown action '" .. tostring(msg.Action) .. "'")
  else
    local ok, out = pcall(function() return handler(base, msg, actor(msg, base), now) end)
    result = ok and out or fail(base, tostring(out))
  end
  Timelock.rev = int(Timelock.rev, 0) + 1
  result.timelockstate = encode(Timelock)
  result.timelockrev = string.format("%d", Timelock.rev)
  result.beaconinfo = encode(info())
  collectgarbage("collect")
  return result
end
