-- consumer.lua: a soak-test contract that uses lib/rng.lua the way a game
-- would. Bundled after vendor/json.lua, vendor/jsonenc.lua and lib/rng.lua
-- (global `rng`). Publishes `consumerstats` for the soak checker.
--
--   Configure  (owner)  Data { beacon, self }
--   Play       (anyone) Count = 1..10, Tier = local | beacon
--   RNG-Result / RNG-Error  from the beacon

local json = require(".json")
local SIGNATURE_ALGS = { ["rsa-pss-sha512"] = true, ["rsa-pss-sha256"] = true }
local RESULT_HISTORY = 40

local function fresh()
  return {
    rev = 0, beacon = "", self = "",
    plays = 0, requested = 0, received = 0, errors = 0, localDraws = 0,
    faces = { 0, 0, 0, 0, 0, 0 },     -- beacon dice, for the distribution check
    localFaces = { 0, 0, 0, 0, 0, 0 },
    pending = {},                      -- requestId -> requested at (ms)
    results = {},                      -- last RESULT_HISTORY { requestId, round, value, die, latencyMs }
    lastError = "",
  }
end
Consumer = Consumer or fresh()

local function int(v, d)
  local n = tonumber(v)
  return n and math.tointeger(n) or d
end

local function deflate(v)
  if type(v) == "number" then return math.tointeger(v) or v end
  if type(v) ~= "table" then return v end
  for k, x in pairs(v) do v[k] = deflate(x) end
  return v
end

local function provenSigner(msg)
  local c = msg.commitments
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
  local fromProcess = msg["from-process"]
  if signed and fromProcess and signed == schedulerAddress(base) then return fromProcess end
  return signed
end

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

local function field(msg, name)
  local v = msg[name]
  if v ~= nil then return v end
  local lower = name:lower()
  for k, x in pairs(msg) do if tostring(k):lower() == lower then return x end end
  return nil
end

local NOW = 0

local function record(list, entry)
  list[#list + 1] = entry
  while #list > RESULT_HISTORY do table.remove(list, 1) end
end

rng.on("Roll", function(r, ctx, info)
  local die = r:int(1, 6)
  if info.tier == "local" then
    Consumer.localDraws = Consumer.localDraws + 1
    Consumer.localFaces[die] = Consumer.localFaces[die] + 1
    return
  end
  local at = int(Consumer.pending[info.requestId], NOW)
  Consumer.pending[info.requestId] = nil
  Consumer.received = Consumer.received + 1
  Consumer.faces[die] = Consumer.faces[die] + 1
  record(Consumer.results, { requestId = info.requestId, round = info.round, value = info.value, die = die, latencyMs = NOW - at })
end)

local H = {}

H["Configure"] = function(base, msg)
  if provenSigner(msg) ~= Owner then return { error = "Not authorised" } end
  local d = json.decode(field(msg, "Data") or "{}")
  Consumer.beacon = d.beacon or Consumer.beacon
  Consumer.self = d.self or Consumer.self
  return { ok = true }
end

H["Play"] = function(base, msg, from, req)
  if not from then return { error = "Unsigned" } end
  local count = math.max(1, math.min(10, int(field(msg, "Count"), 1)))
  local tier = field(msg, "Tier") or "local"
  local seedMsg = { Target = Consumer.self, Slot = req.slot, Timestamp = NOW }
  Consumer.plays = Consumer.plays + 1
  local ids = {}
  for i = 1, count do
    local id = rng.request(seedMsg, { tier = tier, on = "Roll", salt = i })
    if tier ~= "local" then
      Consumer.pending[id] = NOW
      Consumer.requested = Consumer.requested + 1
    end
    ids[#ids + 1] = id
  end
  return { requested = ids, tier = tier }
end

H["RNG-Result"] = function(base, msg, from)
  local n, why = rng.handle(msg, from)
  return { handled = n, reason = why }
end

H["RNG-Error"] = function(base, msg, from)
  if from ~= Consumer.beacon then return { ignored = true } end
  local d = json.decode(field(msg, "Data") or "{}")
  Consumer.errors = Consumer.errors + 1
  Consumer.lastError = tostring(d.error)
  if d.requestId then
    Consumer.pending[d.requestId] = nil
    RngPending[d.requestId] = nil
  end
  return { error = d.error }
end

H["Get-Stats"] = function() return { ok = true } end

local function restore(base)
  if int(base.consumerrev, 0) <= int(Consumer.rev, 0) then return end
  local ok, saved = pcall(json.decode, base.consumerstate or "")
  if ok and type(saved) == "table" then
    Consumer = fresh()
    for k, v in pairs(deflate(saved)) do Consumer[k] = v end
    RngPending = Consumer.rngPending or {}
  end
end

function compute(base, req)
  base = type(base) == "table" and base or {}
  restore(base)
  resolveOwner(base)
  NOW = int(req and req.timestamp, 0)
  local msg = (req and req.body) or {}
  local outbox = {}
  rng.config({ beacon = Consumer.beacon, outbox = outbox })
  local action = field(msg, "Action") or "none"
  local handler = H[action]
  local out
  if not handler then
    out = { error = "unknown action '" .. tostring(action) .. "'" }
  else
    local ok, res = pcall(handler, base, msg, actor(msg, base), req)
    out = ok and res or { error = tostring(res) }
  end
  base.results = { output = { data = encode(out) }, outbox = outbox }

  local pendingCount = 0
  for _ in pairs(Consumer.pending) do pendingCount = pendingCount + 1 end
  Consumer.rev = int(Consumer.rev, 0) + 1
  Consumer.rngPending = RngPending
  base.consumerstate = encode(Consumer)
  base.consumerrev = string.format("%d", Consumer.rev)
  base.consumerstats = encode({
    plays = Consumer.plays, requested = Consumer.requested, received = Consumer.received,
    errors = Consumer.errors, localDraws = Consumer.localDraws, pendingCount = pendingCount,
    faces = Consumer.faces, localFaces = Consumer.localFaces, results = Consumer.results,
    pending = Consumer.pending, lastError = Consumer.lastError,
  })
  collectgarbage("collect")
  return base
end
