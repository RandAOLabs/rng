-- consumer_test.lua: drives consumer.lua's compute() slot by slot.
local passed, failed, lines = 0, 0, {}
local function check(name, ok, detail)
  if ok then passed = passed + 1 else
    failed = failed + 1
    lines[#lines + 1] = "FAIL " .. name .. (detail ~= nil and (": " .. tostring(detail)) or "")
  end
end
local function eq(name, got, want) check(name, got == want, "got " .. tostring(got) .. ", want " .. tostring(want)) end

local OWNER, SCHED, BEACON, ME, PLAYER = ("owner"):rep(1) .. ("_"):rep(38), ("sched"):rep(1) .. ("_"):rep(38),
  ("beacon"):rep(1) .. ("_"):rep(37), ("consumer"):rep(1) .. ("_"):rep(35), ("player"):rep(1) .. ("_"):rep(37)
local base = { ["scheduler-location"] = SCHED, process = { commitments = { p = { type = "rsa-pss-sha512", committer = OWNER } } } }
local slot, clock = 0, 1700000000000

local function wallet(signer, fields)
  local body = { commitments = { c = { type = "rsa-pss-sha512", committer = signer } } }
  for k, v in pairs(fields) do body[k] = v end
  return body
end
local function fromProcess(pid, fields)
  local body = wallet(SCHED, fields)
  body["from-process"] = pid
  return body
end
local function send(body, advance)
  slot, clock = slot + 1, clock + (advance or 1000)
  base = compute(base, { body = body, slot = slot, timestamp = clock })
  return json.decode(base.results.output.data), base.results.outbox
end
local function stats() return json.decode(base.consumerstats) end

function runConsumerTests()
  send(wallet(OWNER, { Action = "Configure", Data = encode({ beacon = BEACON, self = ME }) }))
  local out, ob = send(wallet(PLAYER, { Action = "Play", Count = "3", Tier = "local" }))
  eq("local plays draw now", stats().localDraws, 3)
  eq("no message for local", next(ob), nil)

  out, ob = send(wallet(PLAYER, { Action = "Play", Count = "2", Tier = "beacon" }))
  local ids = out.requested
  eq("two beacon requests", #ids, 2)
  local req = ob["rng-request-" .. ids[1]]
  check("request goes to the beacon", req and req.target == BEACON and req.Action == "Request-Random" and req.Tier == "quick")
  check("request ids unique", ids[1] ~= ids[2])
  eq("pending 2", stats().pendingCount, 2)

  local data = encode({ round = 1, signature = "ab", results = { { requestId = ids[1], value = "cafe", round = 1 }, { requestId = ids[2], value = "f00d", round = 1 } } })
  send(fromProcess("forger" .. ("_"):rep(37), { Action = "RNG-Result", Data = data }))
  eq("result from another process ignored", stats().received, 0)
  send(fromProcess(BEACON, { Action = "RNG-Result", Data = data }), 2500)
  local s = stats()
  eq("both results received", s.received, 2)
  eq("nothing pending", s.pendingCount, 0)
  eq("die matches the library stream", s.results[1].die, rng.stream("beacon|cafe"):int(1, 6))
  eq("latency measured", s.results[1].latencyMs, 3500)

  send(fromProcess(BEACON, { Action = "RNG-Result", Data = data }))
  eq("redelivery counted once", stats().received, 2)

  out = send(wallet(PLAYER, { Action = "Play", Count = "1", Tier = "beacon" }))
  send(fromProcess(BEACON, { Action = "RNG-Error", Data = encode({ error = "Duplicate-Request", requestId = out.requested[1] }) }))
  s = stats()
  check("duplicate for a pending id keeps it pending", s.pendingCount == 1 and s.errors == 0 and RngPending[out.requested[1]] ~= nil)
  send(fromProcess(BEACON, { Action = "RNG-Error", Data = encode({ error = "Insufficient-Balance", requestId = out.requested[1] }) }))
  s = stats()
  eq("error recorded", s.errors, 1)
  eq("errored request no longer pending", s.pendingCount, 0)

  -- Configure needs a real owner.
  local savedOwner, savedProcess = Owner, base.process
  Owner, base.process = nil, nil
  out = send({ Action = "Configure", Data = encode({ beacon = PLAYER }) })
  check("no owner: unsigned configure refused", out.error == "Not authorised" and Consumer.beacon == BEACON, out.error)
  Owner, base.process = savedOwner, savedProcess

  -- A VM that lost its globals comes back from the published state.

  Consumer, RngPending = { rev = 0 }, {}
  send(wallet(PLAYER, { Action = "Get-Stats" }))
  eq("stats restored", stats().received, 2)

  lines[#lines + 1] = passed .. " passed, " .. failed .. " failed"
  return table.concat(lines, "\n")
end
function rngtest() return runConsumerTests() end
