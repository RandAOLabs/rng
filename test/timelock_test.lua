-- timelock_test.lua: drives beacon/timelock.lua's compute() slot by slot.
-- Bundled by run-timelock-tests.mjs after fixtures F (addresses, answers the
-- mocked device accepts, expected values) and P (puzzles per round/validator).

local passed, failed, lines = 0, 0, {}
local function check(name, ok, detail)
  if ok then passed = passed + 1 else
    failed = failed + 1
    lines[#lines + 1] = "FAIL " .. name .. (detail ~= nil and (": " .. tostring(detail)) or "")
  end
end
local function eq(name, got, want) check(name, got == want, "got " .. tostring(got) .. ", want " .. tostring(want)) end

-- timelock@1.0, mocked: valid exactly for the answers the reference produced.
RngDeviceResolve = function(m)
  local key = m.path:gsub("^/~timelock@1.0/", "") .. "|" .. m.modulus .. "|" .. m.seed .. "|" .. m.y .. "|" .. (m.p or m.proof)
  return "ok", { valid = F.ok[key] == true }
end

local base = { ["scheduler-location"] = F.sched, process = { commitments = { p = { type = "rsa-pss-sha512", committer = F.owner } } } }
local clock = 1700000000000
local A, B, C = F.v[1], F.v[2], F.v[3]

local function wallet(signer, fields)
  local body = { commitments = { c = { type = "rsa-pss-sha256", committer = signer } } }
  for k, v in pairs(fields) do body[k] = v end
  return body
end
local function delivery(pid, fields)
  local body = wallet(F.sched, fields)
  body["from-process"] = pid
  return body
end
local function send(body, advance)
  clock = clock + (advance or 100)
  base = compute(base, { body = body, timestamp = clock })
  local ok, d = pcall(json.decode, base.results.output.data or "")
  return ok and d or {}, base.results.outbox or {}
end
local function info() return json.decode(base.beaconinfo) end
local function commit(v, r, key) return send(wallet(v, { Action = "Commit", Data = encode({ round = r, modulus = P[key].N }) })) end
local function reveal(v, r, key, p) return send(wallet(v, { Action = "Reveal", Data = encode({ round = r, y = P[key].y, p = p or P[key].p }) })) end
local function request(id) return send(delivery(F.game, { Action = "Request-Random", Tier = "timelock", ["Request-Id"] = id })) end

function runTimelockTests()
  local U = F.unit
  local r, ob = send(wallet(F.stranger, { Action = "Configure", Data = F.config }))
  eq("configure owner-only", r.error, "Not authorised")
  send(wallet(F.owner, { Action = "Configure", Data = F.config }))
  r = send(wallet(F.stranger, { Action = "Admin.Add-Validator", Data = encode({ address = A }) }))
  eq("add validator owner-only", r.error, "Not authorised")
  -- Validators bond 25,000 RNG; an unbonded one is added suspended.
  for i, v in ipairs(F.v) do
    send(delivery(F.token, { Action = "Credit-Notice", Sender = F.owner, Quantity = tostring(25000 * U), ["X-For"] = v, ["X-Bond"] = "true", Reference = "bond" .. i }))
    send(wallet(F.owner, { Action = "Admin.Add-Validator", Data = encode({ address = v }) }))
  end
  eq("bond credited", Timelock.bonds[A], 25000)
  check("bond is not a request balance", Timelock.balances[A] == nil)
  send(wallet(F.owner, { Action = "Admin.Add-Validator", Data = encode({ address = F.stranger }) }))
  check("unbonded validator starts suspended", Timelock.validators[F.stranger].suspended == true)
  send(wallet(F.owner, { Action = "Admin.Remove-Validator", Data = encode({ address = F.stranger }) }))
  eq("price is 3 validators + 1", info().price, 4)
  send(delivery(F.token, { Action = "Credit-Notice", Sender = F.game, Quantity = tostring(40 * U), Reference = "t1" }))

  -- Round 1: everyone commits and reveals.
  r = request("req-1")
  eq("request binds to round 1", r.round, 1)
  r = send(wallet(F.stranger, { Action = "Commit", Data = encode({ round = 1, modulus = P.r1v0.N }) }))
  eq("non-validator cannot commit", r.error, "Not an active validator")
  r = send(wallet(A, { Action = "Commit", Data = encode({ round = 1, modulus = "abc" }) }))
  eq("short modulus refused", r.error, "Bad-Modulus")
  commit(A, 1, "r1v0")
  eq("phase commit after the first commit", info().open.phase, "commit")
  r = request("req-2")
  eq("request during commits binds to the committing round", r.round, 1)
  r = reveal(A, 1, "r1v0")
  eq("no reveal while committing", r.error, "Not-Revealing")
  commit(B, 1, "r1v1")
  r = commit(C, 1, "r1v2")
  eq("all committed: reveals open", r.phase, "reveal")
  r = request("req-2b")
  eq("request once commits close binds to the next round", r.round, 2)
  -- Rounds overlap: round 2 takes commits while round 1 reveals.
  r = commit(A, 2, "r2v0")
  eq("next round commits while round 1 reveals", r.round, 2)
  eq("round 2 is the open round", info().open.round, 2)
  eq("round 1 listed as revealing", info().revealing[1].round, 1)
  r = commit(B, 1, "r1v1")
  eq("late commit to a revealing round", r.error, "Commits-Closed")
  r = reveal(A, 1, "r1v0", P.r1v0.badp)
  eq("wrong factor refused", r.error, "Bad-Reveal")
  reveal(A, 1, "r1v0")
  reveal(B, 1, "r1v1")
  r, ob = reveal(C, 1, "r1v2")
  eq("round 1 finalized", info().round, 1)
  eq("value matches the reference", r.value, F.value1)
  local res = ob["rng-result-1"] and json.decode(ob["rng-result-1"].Data)
  check("result goes to the game", ob["rng-result-1"] and ob["rng-result-1"].target == F.game)
  eq("request value", res and res.results[1].value, F.out1)
  eq("validator a paid for both requests", Timelock.accrued[A], 2)
  eq("protocol paid", Timelock.protocolAccrued, 2)
  eq("game balance 40 - 3 x 4", Timelock.balances[F.game], 28)
  local rec = json.decode(base.timelockstate).rounds["1"]
  check("round record keeps commits and outputs", rec and rec.commits[A] == P.r1v0.N and rec.outputs[B].p == P.r1v1.p)

  -- Round 2: c withholds; round 3 runs and finishes while round 2 waits for its crack.
  commit(B, 2, "r2v1"); commit(C, 2, "r2v2")
  reveal(A, 2, "r2v0"); reveal(B, 2, "r2v1")
  local crack = { round = 2, validator = C, y = F.crack2.y, proof = F.crack2.proof }
  r = send(wallet(A, { Action = "Crack", Data = encode(crack) }))
  eq("crack before the deadline refused", r.error, "Too-Early")

  -- Round 3: c misses the commit window; 2 commits still count; 1 RNG refunded.
  r = request("req-3")
  eq("request binds to round 3", r.round, 3)
  commit(A, 3, "r3v0"); commit(B, 3, "r3v1")
  r = reveal(A, 3, "r3v0", nil)
  eq("reveal waits for the commit window", r.error, "Not-Revealing")
  send(wallet(A, { Action = "Get-Info" }), 3000)
  reveal(A, 3, "r3v0")
  r = reveal(B, 3, "r3v1")
  eq("round 3 finalized before round 2", info().round, 3)
  check("round 2 still open", json.decode(base.timelockstate).rounds["2"] == nil)
  eq("missed commit is not a strike", #Timelock.validators[C].strikes, 0)
  eq("missed commit counted", Timelock.validators[C].missed, 1)
  eq("unserved validator's share refunded", Timelock.balances[F.game], 28 - 4 + 1)

  r = send(wallet(A, { Action = "Crack", Data = encode({ round = 2, validator = C, y = F.crack2.y, proof = "1" .. F.crack2.proof }) }), 10000)
  eq("bad proof refused", r.error, "Bad-Crack")
  r = send(wallet(A, { Action = "Crack", Data = encode(crack) }))
  check("crack finalizes round 2 late", json.decode(base.timelockstate).rounds["2"] ~= nil)
  eq("highest round stays 3", info().round, 3)
  eq("cracked value matches the reference", r.value, F.value2)
  eq("cracker takes the withholder's fee", Timelock.accrued[A], 5)
  eq("withholder earns nothing", Timelock.accrued[C], 2)
  eq("withholder struck", #Timelock.validators[C].strikes, 1)

  -- Round 4: c withholds again; with suspendAfter 2 that suspends it and
  -- slashes 1,000 from its bond; price drops to 3.
  send(wallet(F.owner, { Action = "Configure", Data = encode({ suspendAfter = 2 }) }))
  local protocolBefore = Timelock.protocolAccrued
  request("req-4")
  commit(A, 4, "r4v0"); commit(B, 4, "r4v1"); commit(C, 4, "r4v2")
  eq("a commit resets missed", Timelock.validators[C].missed, 0)
  reveal(A, 4, "r4v0"); reveal(B, 4, "r4v1")
  send(wallet(A, { Action = "Crack", Data = encode({ round = 4, validator = C, y = F.crack4.y, proof = F.crack4.proof }) }), 10000)
  eq("round 4 finalized", info().round, 4)
  check("c suspended after 2 strikes", Timelock.validators[C].suspended == true and not Timelock.validators[C].idle)
  eq("suspension slashes the bond", Timelock.bonds[C], 24000)
  eq("slash goes to the protocol", Timelock.protocolAccrued - protocolBefore, 1000 + 1)
  eq("price without c", info().price, 3)
  r = send(wallet(C, { Action = "Commit", Data = encode({ round = 5, modulus = P.r5v0.N }) }))
  eq("suspended validator cannot commit", r.error, "Not an active validator")

  -- Round 5: only a commits, twice: void both times, and b, missing both,
  -- goes idle: suspended without a slash.
  request("req-5")
  for _ = 1, 2 do
    commit(A, 5, "r5v0")
    send(wallet(A, { Action = "Get-Info" }), 3000)
    reveal(A, 5, "r5v0")
  end
  eq("void round reopens", info().open.phase, "collecting")
  eq("void round keeps its number", info().open.round, 5)
  eq("request still pending", info().open.pending, 1)
  check("b idle after 2 missed commits", Timelock.validators[B].suspended == true and Timelock.validators[B].idle == true)
  eq("idle is not slashed", Timelock.bonds[B], 25000)
  r = send(wallet(B, { Action = "Rejoin" }))
  check("idle validator rejoins at once", r.error == nil and Timelock.validators[B].suspended == false, r.error)

  r = send(wallet(C, { Action = "Rejoin" }))
  eq("rejoin waits rejoinAfter rounds", r.error, "Too-Soon")
  send(wallet(F.owner, { Action = "Configure", Data = encode({ rejoinAfter = 0 }) }))
  Timelock.bonds[C] = 999
  r = send(wallet(C, { Action = "Rejoin" }))
  eq("rejoin needs a bond covering the next slash", r.error, "Bond-Too-Low")
  Timelock.bonds[C] = 24000
  r = send(wallet(A, { Action = "Rejoin" }))
  eq("only a suspended validator rejoins", r.error, "Not suspended")
  send(wallet(C, { Action = "Rejoin" }))
  check("c rejoined", Timelock.validators[C].suspended == false)
  eq("rejoin clears strikes", #Timelock.validators[C].strikes, 0)
  eq("price back to 4", info().price, 4)
  Timelock.validators[C].suspended = true
  send(wallet(F.owner, { Action = "Admin.Reinstate", Data = encode({ address = C }) }))
  check("admin can still reinstate", Timelock.validators[C].suspended == false)

  -- A VM that lost its globals comes back from the published state.
  Timelock = { rev = 0 }
  send(wallet(F.stranger, { Action = "Get-Info" }))
  eq("state restored", info().round, 4)

  -- Duplicates and claims.
  r, ob = request("req-1")
  check("duplicate request refused", ob["rng-error"] ~= nil)
  local owed = Timelock.accrued[A]
  r, ob = send(wallet(A, { Action = "Claim" }))
  check("claim pays out through the token", ob["rng-claim"] and ob["rng-claim"].Quantity == string.format("%d", owed * U), owed)
  eq("accrued reset", Timelock.accrued[A], 0)
  -- Heartbeat on (the default), rounds run with nobody waiting; off, a round needs a request.
  Timelock.pending = {}
  local open = info().open.round
  send(wallet(F.owner, { Action = "Configure", Data = encode({ heartbeat = 0 }) }))
  r = send(wallet(A, { Action = "Commit", Data = encode({ round = open, modulus = P.r5v0.N }) }))
  eq("heartbeat off: no round without a request", r.error, "Nothing-Pending")
  send(wallet(F.owner, { Action = "Configure", Data = encode({ heartbeat = 1 }) }))
  r = send(wallet(A, { Action = "Commit", Data = encode({ round = open, modulus = P.r5v0.N }) }))
  check("heartbeat on: a round opens with nobody waiting", r.error == nil, r.error)

  r, ob = send(wallet(F.owner, { Action = "Admin.Remove-Validator", Data = encode({ address = B }) }))
  check("removal refunds the bond", ob["rng-bond-refund"] and ob["rng-bond-refund"].Recipient == B and ob["rng-bond-refund"].Quantity == string.format("%d", 25000 * U))

  lines[#lines + 1] = passed .. " passed, " .. failed .. " failed"
  return table.concat(lines, "\n")
end
function rngtest()
  local ok, out = pcall(runTimelockTests)
  if ok then return out end
  return "ERROR " .. tostring(out) .. "\n" .. table.concat(lines, "\n")
end
