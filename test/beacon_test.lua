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
  eq("no RNG-Funded (the account may be a wallet)", next(ob), nil)
  send(delivery(F.token, { Action = "Credit-Notice", Sender = F.game, Quantity = tostring(10 * U), Reference = "t1" }))
  eq("same notice twice credits once", Beacon.balances[F.game], 10)
  send(wallet(F.stranger, { Action = "Credit-Notice", Sender = F.stranger, Quantity = tostring(99 * U), ["from-process"] = F.token, Reference = "t7" }))
  eq("wallet forging from-process credits nothing", Beacon.balances[F.stranger], nil)
  send({ Action = "Credit-Notice", Sender = F.stranger, Quantity = tostring(99 * U), ["from-process"] = F.token, Reference = "t8" })
  eq("unsigned from-process credits nothing", Beacon.balances[F.stranger], nil)
  r = send(delivery(F.token, { Action = "Credit-Notice", Sender = F.game, Quantity = tostring(5 * U) }))
  check("notice without a reference refused", r.error == "Missing-Reference" and Beacon.balances[F.game] == 10)
  r, ob = send(delivery(F.token, { Action = "Credit-Notice", Sender = F.game, Quantity = "500", Reference = "t3" }))
  check("dust refunded to the sender", ob["rng-refund"] and ob["rng-refund"].Recipient == F.game and ob["rng-refund"].Quantity == "500")
  _, ob = send(delivery(F.token, { Action = "Credit-Notice", Sender = F.game, Quantity = "500", Reference = "t3" }))
  eq("dust refunded once", next(ob), nil)
  _, ob = send(delivery(F.token, { Action = "Credit-Notice", Sender = F.game, ["X-For"] = "bad", Quantity = tostring(2 * U), Reference = "t4" }))
  check("invalid X-For refunded", ob["rng-refund"] and ob["rng-refund"].Quantity == tostring(2 * U) and Beacon.balances[F.game] == 10)

  -- Requests bind to round + 2.
  r, ob = send(wallet(F.stranger, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = "x1" }))
  check("unfunded wallet refused, no message to a wallet", r.error == "Insufficient-Balance" and next(ob) == nil)
  local t1 = tostring(clock)
  r = send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = F.req1, ["Request-Time"] = t1 }))
  eq("request binds to round + 2", r.round, 2)
  send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = F.req2, ["Request-Time"] = tostring(clock) }))
  r, ob = send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = F.req2 }))
  check("redelivered request: no RNG-Error", r.duplicate == true and next(ob) == nil)
  eq("balance debited 6", Beacon.balances[F.game], 4)
  r, ob = send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = "old", ["Request-Time"] = tostring(clock - 700000) }))
  check("stale Request-Time refused uncharged", r.error == "Stale-Request" and ob["rng-error"] and Beacon.balances[F.game] == 4)
  eq("two pending", info().pendingCount, 2)
  eq("round message", info().roundMessage, F.beacon .. "|1")
  eq("bind round", info().bindRound, 2)

  -- Partials are exchanged through the beacon for the open round only.
  r = send(wallet(F.stranger, { Action = "Partial", Data = encode({ round = 1, signature = "aa" }) }))
  eq("partial from non-member refused", r.error, "Not a committee member")
  r = send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 2, signature = "aa" }) }))
  eq("partial for the bound round refused", r.error, "Bad-Round")
  send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 1, signature = "p1" }) }))
  r = send(wallet(F.members[3], { Action = "Partial", Data = encode({ round = 1, signature = "p3" }) }))
  eq("two partials held", r.partials, 2)
  local pub = json.decode(base.beaconpartials)
  eq("partials published for round 1", pub.round, 1)
  eq("member 3 partial readable", pub.by[F.members[3]], "p3")
  eq("no request bound to a round with partials", Beacon.pending[tostring(pub.round)], nil)

  -- Rounds: 2 of 3 matching attestations finalize.
  r = send(wallet(F.stranger, { Action = "Round", Data = encode({ round = 1, signature = F.sig1 }) }))
  eq("non-member refused", r.error, "Not a committee member")
  r = send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 2, signature = F.sig2 }) }))
  eq("post for the bound round refused", r.error, "Bad-Round")
  send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 1, signature = F.fake1 }) }))
  eq("one forged attestation does not finalize", info().round, 0)
  send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 1, signature = F.sig1 }) }))
  eq("switching signature counted as equivocation", Beacon.equivocations[F.members[1]], 1)
  send(wallet(F.members[2], { Action = "Round", Data = encode({ round = 1, signature = F.sig1 }) }))
  eq("forged + honest does not finalize", info().round, 0)
  r = send(wallet(F.members[3], { Action = "Round", Data = encode({ round = 1, signature = F.sig1 }) }))
  eq("second honest attestation finalizes", info().round, 1)
  eq("round 1 value", r.value, F.value1)
  eq("round 1 serves nothing (requests bound to 2)", r.served, 0)
  eq("partials cleared after the round", next(json.decode(base.beaconpartials).by), nil)

  send(wallet(F.members[2], { Action = "Round", Data = encode({ round = 2, signature = F.sig2 }) }), 5000)
  r, ob = send(wallet(F.members[3], { Action = "Round", Data = encode({ round = 2, signature = F.sig2 }) }))
  eq("round 2 finalized", info().round, 2)
  eq("served 2", r.served, 2)
  local res = ob["rng-result-1"]
  check("one batched result to the game", res and res.target == F.game and ob["rng-result-2"] == nil)
  local data = json.decode(res.Data)
  eq("result 1 value (requester mixed in)", data.results[1].value, F.out1)
  eq("result 2 value", data.results[2].value, F.out2)
  eq("signer 2 paid 2", Beacon.accrued[F.members[2]], 2)
  eq("signer 3 paid 2", Beacon.accrued[F.members[3]], 2)
  eq("forger paid nothing", Beacon.accrued[F.members[1]], nil)
  eq("protocol paid 2", Beacon.protocolAccrued, 2)

  -- Guards are published apart, and not rewritten by a free message.
  local guards = base.beaconguards
  send(wallet(F.stranger, { Action = "Get-Info" }))
  eq("state publishes no seen map", json.decode(base.beaconstate).seen, nil)
  eq("free message leaves the guards alone", base.beaconguards, guards)
  -- Request ids are published in shards by bound round, not in the guards.
  eq("guards carry no seen map", json.decode(base.beaconguards).seen, nil)
  local shards = 0
  for k, v in pairs(base) do
    if type(k) == "string" and k:match("^beaconseen%-") and json.decode(v)[F.game .. "|" .. F.req1] then shards = shards + 1 end
  end
  eq("request id published in one shard", shards, 1)

  -- A VM that lost its globals comes back from the published state.
  Beacon = nil
  Beacon = { rev = 0 }
  send(wallet(F.stranger, { Action = "Get-Info" }))
  eq("state restored after losing globals", info().round, 2)
  eq("balances restored", Beacon.balances[F.game], 4)
  check("guards restored", Beacon.seen[F.game .. "|" .. F.req1] ~= nil and Beacon.credited["1"] == true)
  r = send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = F.req1 }))
  check("duplicate still refused after restore", r.duplicate == true)

  -- Withdraw takes whole amounts only.
  r = send(delivery(F.game, { Action = "Withdraw", Quantity = "1.5" }))
  check("fractional withdraw refused", r.error == "Bad-Quantity" and Beacon.balances[F.game] == 4)
  r = send(delivery(F.game, { Action = "Withdraw", Quantity = "lots" }))
  check("garbage withdraw refused", r.error == "Bad-Quantity" and Beacon.balances[F.game] == 4)

  -- Cadence.
  send(wallet(F.owner, { Action = "Configure", Data = encode({ cadenceMs = 60000 }) }))
  send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = F.req3 }))
  r = send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 3, signature = F.sig3 }) }))
  eq("round inside the cadence refused", r.error, "Too-Early")
  send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 3, signature = F.sig3 }) }), 60000)
  send(wallet(F.members[2], { Action = "Round", Data = encode({ round = 3, signature = F.sig3 }) }))
  eq("round 3 finalized", info().round, 3)
  eq("balance 1", Beacon.balances[F.game], 1)

  -- Claims and owner-only actions.
  r, ob = send(wallet(F.members[2], { Action = "Claim" }))
  local t = ob["rng-claim"]
  check("claim pays out through the token", t and t.target == F.token and t.Recipient == F.members[2]
    and t.Quantity == string.format("%d", 2 * U), t and t.Quantity)
  eq("accrued reset", Beacon.accrued[F.members[2]], 0)
  r = send(wallet(F.stranger, { Action = "Claim-Protocol" }))
  eq("protocol claim owner-only", r.error, "Not authorised")
  r = send(wallet(F.stranger, { Action = "Admin.Eval", Data = "Beacon.cadenceMs = 1" }))
  eq("admin eval owner-only", r.error, "Not authorised")
  r = send(wallet(F.owner, { Action = "Admin.Eval", Data = "Beacon.cadenceMs = 4000" }))
  eq("owner eval applies", Beacon.cadenceMs, 4000)
  local savedOwner, savedProcess = Owner, base.process
  Owner, base.process = nil, nil
  r = send({ Action = "Admin.Eval", Data = "Beacon.cadenceMs = 7" })
  check("no owner: unsigned admin eval refused", r.error == "Not authorised" and Beacon.cadenceMs == 4000, r.error)
  Owner, base.process = savedOwner, savedProcess
  r = send({ Tags = { Action = "Admin.Eval", Data = "Beacon.cadenceMs = 9",
                      commitments = { c = { type = "rsa-pss-sha512", committer = F.owner } } } })
  check("a Tags table cannot carry commitments", r.error == "Not authorised" and Beacon.cadenceMs == 4000, r.error)
  r = send(wallet(F.stranger, { Action = "Get-Info", Tags = "junk" }))
  eq("string Tags does not crash", r.round, 3)

  -- With the device on, one post with a valid group signature finalizes.
  local savedAo = ao
  ao = { resolve = function(m)
    return "ok", { valid = m["public-key"] == F.groupKey and ((m.signature == F.sig4 and m.message == F.beacon .. "|4")
      or (m.signature == F.sig5 and m.message == F.beacon .. "|5")) }
  end }
  send(wallet(F.owner, { Action = "Configure", Data = encode({ useDevice = true, cadenceMs = 0 }) }))
  send(delivery(F.token, { Action = "Credit-Notice", Sender = F.game, Quantity = tostring(3 * U), Reference = "t2" }))
  send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = "r-four" }))
  r = send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 4, signature = F.fake1 }) }))
  eq("device rejects a forged signature", r.error, "Bad-Signature")
  local before2, before3 = Beacon.accrued[F.members[2]] or 0, Beacon.accrued[F.members[3]] or 0
  send(wallet(F.members[3], { Action = "Partial", Data = encode({ round = 4, signature = "p3" }) }))
  send(wallet(F.members[2], { Action = "Partial", Data = encode({ round = 4, signature = "p2" }) }))
  send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 4, signature = F.sig4 }) }))
  eq("device-verified round finalizes on one post", info().round, 4)
  eq("partial poster 2 paid", (Beacon.accrued[F.members[2]] or 0) - before2, 1)
  eq("partial poster 3 paid", (Beacon.accrued[F.members[3]] or 0) - before3, 1)
  eq("fees balance: signers = threshold x protocol", (function() local a = 0 for _, v in pairs(Beacon.accrued) do a = a + v end return a end)() + 2, 2 * Beacon.protocolAccrued)
  send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 5, signature = F.sig5 }) }))
  eq("round 5 serves the last request", info().pendingCount, 0)

  -- Heartbeat on (the default), rounds run with nobody waiting; off, they wait for a request.
  r = send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 6, signature = "p1" }) }))
  check("heartbeat on: partial with nobody waiting", r.error == nil, r.error)
  send(wallet(F.owner, { Action = "Configure", Data = encode({ heartbeat = false }) }))
  r = send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 6, signature = "p1" }) }))
  eq("heartbeat off: no round without a request", r.error, "Nothing-Pending")

  -- Late redeliveries, long after the request guard forgot the id.
  ao = { resolve = function() return "ok", { valid = true } end }
  send(wallet(F.owner, { Action = "Configure", Data = encode({ heartbeat = true }) }), 700000)
  Beacon.round = 699
  send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 700, signature = "any" }) }))
  eq("request guard pruned", Beacon.seen[F.game .. "|" .. F.req1], nil)
  local bal = Beacon.balances[F.game]
  send(delivery(F.token, { Action = "Credit-Notice", Sender = F.game, Quantity = tostring(10 * U), Reference = "t1" }))
  eq("late Credit-Notice not credited again", Beacon.balances[F.game], bal)
  r = send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = F.req1, ["Request-Time"] = t1 }))
  check("late Request-Random not charged again", r.error == "Stale-Request" and Beacon.balances[F.game] == bal, r.error)
  ao = savedAo

  lines[#lines + 1] = passed .. " passed, " .. failed .. " failed"
  return table.concat(lines, "\n")
end

function rngtest() return runBeaconTests() end
