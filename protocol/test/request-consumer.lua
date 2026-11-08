-- Minimal AO process for the live smoke test (deploy/smoke.mjs, scenario C):
-- a process consumer of the Any-Honest beacon. `Request { Request-Id }` from
-- its owner forwards a Request-Random (paid from this process's beacon
-- balance); the beacon's RNG-Result / RNG-Error push is accepted only when our
-- scheduler attests it comes from the beacon. Publishes `consumerstate`.
local json = require(".json")

Consumer = Consumer or { requested = 0, received = 0, rejected = 0, results = {}, errors = {} }

local function restore(base)
  local ok, saved = pcall(json.decode, base and base.consumerstate or "")
  if ok and type(saved) == "table" then Consumer = saved end
  Consumer.results = type(Consumer.results) == "table" and Consumer.results or {}
  Consumer.errors = type(Consumer.errors) == "table" and Consumer.errors or {}
end

local function field(msg, name)
  for key, value in pairs(msg) do
    if tostring(key):lower() == name:lower() then return value end
  end
  if type(msg.Tags) == "table" then
    for key, value in pairs(msg.Tags) do
      if tostring(key):lower() == name:lower() then return value end
    end
  end
  return nil
end

local function signedBy(msg, who)
  local c = msg.commitments or msg.Commitments
  if type(c) ~= "table" then return false end
  for _, s in pairs(c) do
    if type(s) == "table" and s.committer == who then return true end
  end
  return false
end

function compute(base, req)
  base = type(base) == "table" and base or {}
  restore(base)
  local msg = req and req.body or {}
  local outbox = {}
  local action = field(msg, "Action")
  local from = field(msg, "from-process")
  if action == "Request" and not from and signedBy(msg, "__OWNER__") then
    local id = field(msg, "Request-Id")
    if type(id) == "string" and id ~= "" then
      outbox.request = { target = "__BEACON__", Action = "Request-Random", Tier = "any-honest", ["Request-Id"] = id }
      Consumer.requested = (tonumber(Consumer.requested) or 0) + 1
    end
  elseif action == "RNG-Result" or action == "RNG-Error" then
    local ok, data = pcall(json.decode, field(msg, "Data") or "")
    data = ok and type(data) == "table" and data or {}
    if from ~= "__BEACON__" or not signedBy(msg, "__SCHEDULER__") then
      Consumer.rejected = (tonumber(Consumer.rejected) or 0) + 1
    elseif action == "RNG-Result" then
      for _, r in ipairs(type(data.results) == "table" and data.results or {}) do
        if type(r) == "table" and type(r.requestId) == "string" then
          Consumer.results[r.requestId] = { round = r.round, value = r.value, roundValue = data.value,
            tier = data.tier, from = from }
          Consumer.received = (tonumber(Consumer.received) or 0) + 1
        end
      end
    elseif type(data.requestId) == "string" then
      Consumer.errors[data.requestId] = data.error or "unknown"
    end
  end
  base.results = { output = { data = json.encode(Consumer) }, outbox = outbox }
  base.consumerstate = json.encode(Consumer)
  return base
end
