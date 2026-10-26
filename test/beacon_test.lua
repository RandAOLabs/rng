-- beacon_test.lua: drives beacon.lua's compute() the way a node does, slot by
-- slot, carrying the returned base forward. Bundled by run-beacon-tests.mjs,
-- which prepends `F` (fixtures: addresses, BLS signatures, expected values).

local passed, failed, lines = 0, 0, {}
local function check(name, ok, detail)
  if ok then passed = passed + 1 else
    failed = failed + 1
    lines[#lines + 1] = "FAIL " .. name .. (detail ~= nil and (": " .. tostring(detail)) or "")
  end
end
local function eq(name, got, want) check(name, got == want, "got " .. tostring(got) .. ", want " .. tostring(want)) end

local base = {
  ["scheduler-location"] = F.sched,
  process = { commitments = { p = { type = "rsa-pss-sha512", committer = F.owner } } },
}
local clock = 1700000000000

-- A wallet message, signed by `signer`.
local function wallet(signer, fields)
  local body = { commitments = { c = { type = "rsa-pss-sha512", committer = signer },
                                 h = { type = "hmac-sha256", committer = signer } } }
  for k, v in pairs(fields) do body[k] = v end
  return body
end
-- A delivery from another process: signed by our scheduler, naming the process.
local function delivery(fromProcess, fields)
  local body = wallet(F.sched, fields)
  body["from-process"] = fromProcess
  return body
end

local function send(body, advance)
  clock = clock + (advance or 1000)
  base = compute(base, { body = body, timestamp = clock })
  local out = base.results and base.results.output and base.results.output.data
  local ok, decoded = pcall(json.decode, out or "")
  return ok and decoded or {}, base.results.outbox or {}
end

local function info() return json.decode(base.beaconinfo) end

function runBeaconTests()
  local U = F.unit

  -- Configure: owner only.
  local r = send(wallet(F.stranger, { Action = "Configure", Data = "{}" }))
  eq("configure refused for non-owner", r.error, "Not authorised")
  r = send(wallet(F.owner, { Action = "Configure", Data = F.config }))
  eq("configure sets committee", #r.committee, 3)
  eq("price is 3 RNG", r.price.beacon, 3)

  -- Funding: only the token process, once per reference.
  local _, ob = send(delivery(F.token, { Action = "Credit-Notice", Sender = F.game, Quantity = tostring(10 * U), Reference = "t1" }))
  eq("credited 10", Beacon.balances[F.game], 10)
  check("funded notice sent to the game", ob["rng-funded"] and ob["rng-funded"].target == F.game)
  send(delivery(F.token, { Action = "Credit-Notice", Sender = F.game, Quantity = tostring(10 * U), Reference = "t1" }))
  eq("same notice twice credits once", Beacon.balances[F.game], 10)
  send(wallet(F.stranger, { Action = "Credit-Notice", Sender = F.stranger, Quantity = tostring(99 * U), ["from-process"] = F.token }))
  eq("wallet forging from-process credits nothing", Beacon.balances[F.stranger], nil)

  -- Requests.
  _, ob = send(wallet(F.stranger, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = "x1" }))
  check("unfunded request answered with RNG-Error", ob["rng-error"] and ob["rng-error"].target == F.stranger)
  send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = F.req1 }))
  send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = F.req2 }))
  _, ob = send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = F.req2 }))
  check("duplicate request refused", ob["rng-error"] ~= nil)
  eq("balance debited 6", Beacon.balances[F.game], 4)
  eq("two pending", info().pendingCount, 2)
  eq("round message", info().roundMessage, F.beacon .. "|1")

  -- Partials are exchanged through the beacon for the open round only.
  r = send(wallet(F.stranger, { Action = "Partial", Data = encode({ round = 1, signature = "aa" }) }))
  eq("partial from non-member refused", r.error, "Not a committee member")
  r = send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 2, signature = "aa" }) }))
  eq("partial for a future round refused", r.error, "Bad-Round")
  send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 1, signature = "p1" }) }))
  r = send(wallet(F.members[3], { Action = "Partial", Data = encode({ round = 1, signature = "p3" }) }))
  eq("two partials held", r.partials, 2)
  local pub = json.decode(base.beaconpartials)
  eq("partials published for round 1", pub.round, 1)
  eq("member 3 partial readable", pub.by[F.members[3]], "p3")

  -- Rounds: 2 of 3 matching attestations finalize.
  r = send(wallet(F.stranger, { Action = "Round", Data = encode({ round = 1, signature = F.sig1 }) }))
  eq("non-member refused", r.error, "Not a committee member")
  send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 1, signature = F.fake1 }) }))
  eq("one forged attestation does not finalize", info().round, 0)
  send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 1, signature = F.sig1 }) }))
  eq("switching signature counted as equivocation", Beacon.equivocations[F.members[1]], 1)
  send(wallet(F.members[2], { Action = "Round", Data = encode({ round = 1, signature = F.sig1 }) }))
  eq("forged + honest does not finalize", info().round, 0)
  r, ob = send(wallet(F.members[3], { Action = "Round", Data = encode({ round = 1, signature = F.sig1 }) }))
  eq("second honest attestation finalizes", info().round, 1)
  eq("served 2", r.served, 2)
  local res = ob["rng-result-1"]
  check("one batched result to the game", res and res.target == F.game and ob["rng-result-2"] == nil)
  local data = json.decode(res.Data)
  eq("round value", r.value, F.value1)
  eq("result 1 value", data.results[1].value, F.out1)
  eq("result 2 value", data.results[2].value, F.out2)
  eq("signer 2 paid 2", Beacon.accrued[F.members[2]], 2)
  eq("signer 3 paid 2", Beacon.accrued[F.members[3]], 2)
  eq("forger paid nothing", Beacon.accrued[F.members[1]], nil)
  eq("protocol paid 2", Beacon.protocolAccrued, 2)
  eq("partials cleared after the round", next(json.decode(base.beaconpartials).by), nil)

  -- A VM that lost its globals comes back from the published state.
  Beacon = nil
  Beacon = { rev = 0 }
  send(wallet(F.stranger, { Action = "Get-Info" }))
  eq("state restored after losing globals", info().round, 1)
  eq("balances restored", Beacon.balances[F.game], 4)

  -- Cadence.
  send(wallet(F.owner, { Action = "Configure", Data = encode({ cadenceMs = 60000 }) }))
  send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = F.req3 }))
  r = send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 2, signature = F.sig2 }) }))
  eq("round inside the cadence refused", r.error, "Too-Early")
  send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 2, signature = F.sig2 }) }), 60000)
  send(wallet(F.members[2], { Action = "Round", Data = encode({ round = 2, signature = F.sig2 }) }))
  eq("round 2 finalized", info().round, 2)
  eq("balance 1", Beacon.balances[F.game], 1)

  -- Claims.
  r, ob = send(wallet(F.members[2], { Action = "Claim" }))
  local t = ob["rng-claim"]
  check("claim pays out through the token", t and t.target == F.token and t.Recipient == F.members[2]
    and t.Quantity == string.format("%d", 3 * U), t and t.Quantity)
  eq("accrued reset", Beacon.accrued[F.members[2]], 0)
  r = send(wallet(F.stranger, { Action = "Claim-Protocol" }))
  eq("protocol claim owner-only", r.error, "Not authorised")
  r = send(wallet(F.stranger, { Action = "Admin.Eval", Data = "Beacon.cadenceMs = 1" }))
  eq("admin eval owner-only", r.error, "Not authorised")
  r = send(wallet(F.owner, { Action = "Admin.Eval", Data = "Beacon.cadenceMs = 4000" }))
  eq("owner eval applies", Beacon.cadenceMs, 4000)

  lines[#lines + 1] = passed .. " passed, " .. failed .. " failed"
  return table.concat(lines, "\n")
end

function rngtest() return runBeaconTests() end
