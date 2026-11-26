-- Cryptographic envelope verification happens in the local fixture runner.
-- The production compute(), credits, and request logic run unchanged here.
local json = require(".json")
local config = json.decode(SignedAdmissionFixture)
local base = { ["scheduler-location"] = config.rngScheduler }
Timelock.self, Timelock.token, Timelock.unit = config.beacon, config.token, 1000000
Timelock.params.h = "1"
Timelock.params.requestPrice = 4
-- The fixture supplies an already configured collecting round.
for _, validator in ipairs(config.validators) do
  Timelock.validators[validator] = { ready = true, readyAt = 1, joinedAt = 1 }
  Timelock.bonds[validator] = 25000
end

local function pending()
  local out = {}
  for _, rows in pairs(Timelock.pending) do
    for _, row in ipairs(rows) do
      out[row.requestId] = { payer = row.requester, process = row.process == true }
    end
  end
  return out
end

local function apply(slot)
  base = compute(base, slot)
  return json.decode(base.results.output.data)
end
for _, credit in ipairs(config.credits) do
  local r = apply(credit)
  assert(r.credited == 8 or r.credited == 24, json.encode(r))
end
assert(Timelock.balances[config.wallet] == 8)
assert(Timelock.balances[config.shard] == 8)
assert(Timelock.balances[config.mainScheduler] == 24)

local records = {}
for _, item in ipairs(config.requests) do
  local reply = apply(item.assignment)
  records[item.kind] = {
    reply = reply, pending = pending(),
    wallet = Timelock.balances[config.wallet] or 0,
    shard = Timelock.balances[config.shard] or 0,
    scheduler = Timelock.balances[config.mainScheduler] or 0
  }
end
return json.encode(records)
