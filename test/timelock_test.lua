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
  for _, v in ipairs(F.v) do send(wallet(F.owner, { Action = "Admin.Add-Validator", Data = encode({ address = v }) })) end
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
  eq("request during commits binds to the next round", r.round, 2)
  r = reveal(A, 1, "r1v0")
  eq("no reveal while committing", r.error, "Not-Revealing")
  commit(B, 1, "r1v1")
  r = commit(C, 1, "r1v2")
  eq("all committed: reveals open", r.phase, "reveal")
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
  eq("validator a paid", Timelock.accrued[A], 1)
  eq("protocol paid", Timelock.protocolAccrued, 1)
  eq("game balance 40 - 2 x 4", Timelock.balances[F.game], 32)
  local rec = json.decode(base.timelockstate).rounds["1"]
  check("round record keeps commits and outputs", rec and rec.commits[A] == P.r1v0.N and rec.outputs[B].p == P.r1v1.p)

  -- Round 2: c withholds; a cracks it after the reveal deadline.
  commit(A, 2, "r2v0"); commit(B, 2, "r2v1"); commit(C, 2, "r2v2")
  reveal(A, 2, "r2v0"); reveal(B, 2, "r2v1")
  local crack = { round = 2, validator = C, y = F.crack2.y, proof = F.crack2.proof }
  r = send(wallet(A, { Action = "Crack", Data = encode(crack) }))
  eq("crack before the deadline refused", r.error, "Too-Early")
  r = send(wallet(A, { Action = "Crack", Data = encode({ round = 2, validator = C, y = F.crack2.y, proof = "1" .. F.crack2.proof }) }), 10000)
  eq("bad proof refused", r.error, "Bad-Crack")
  r = send(wallet(A, { Action = "Crack", Data = encode(crack) }))
  eq("crack finalizes round 2", info().round, 2)
  eq("cracked value matches the reference", r.value, F.value2)
  eq("cracker takes the withholder's fee", Timelock.accrued[A], 3)
  eq("withholder earns nothing", Timelock.accrued[C], 1)
  eq("withholder struck", #Timelock.validators[C].strikes, 1)

  -- Round 3: c misses the commit window; 2 commits still count; 1 RNG refunded.
  request("req-3")
  commit(A, 3, "r3v0"); commit(B, 3, "r3v1")
  r = reveal(A, 3, "r3v0", nil)
  eq("reveal waits for the commit window", r.error, "Not-Revealing")
  reveal(A, 3, "r3v0")
  send(wallet(A, { Action = "Get-Info" }), 3000)
  reveal(A, 3, "r3v0")
  r = reveal(B, 3, "r3v1")
  eq("round 3 finalized with 2 commits", info().round, 3)
  eq("missed commit struck", #Timelock.validators[C].strikes, 2)
  eq("unserved validator's share refunded", Timelock.balances[F.game], 32 - 4 + 1)

  -- Round 4: another miss suspends c; price drops to 3.
  request("req-4")
  commit(A, 4, "r4v0"); commit(B, 4, "r4v1")
  send(wallet(A, { Action = "Get-Info" }), 3000)
  reveal(A, 4, "r4v0"); reveal(B, 4, "r4v1")
  eq("round 4 finalized", info().round, 4)
  check("c suspended after 3 strikes", Timelock.validators[C].suspended == true)
  eq("price without c", info().price, 3)
  r = send(wallet(C, { Action = "Commit", Data = encode({ round = 5, modulus = P.r5v0.N }) }))
  eq("suspended validator cannot commit", r.error, "Not an active validator")

  -- Round 5: only a commits: the round is void and the request waits.
  request("req-5")
  commit(A, 5, "r5v0")
  send(wallet(A, { Action = "Get-Info" }), 3000)
  r = reveal(A, 5, "r5v0")
  eq("void round reopens", info().open.phase, "collecting")
  eq("void round keeps its number", info().open.round, 5)
  eq("request still pending", info().open.pending, 1)

  send(wallet(F.owner, { Action = "Admin.Reinstate", Data = encode({ address = C }) }))
  check("reinstated", Timelock.validators[C].suspended == false)
  eq("price back to 4", info().price, 4)

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

  lines[#lines + 1] = passed .. " passed, " .. failed .. " failed"
  return table.concat(lines, "\n")
end
function rngtest()
  local ok, out = pcall(runTimelockTests)
  if ok then return out end
  return "ERROR " .. tostring(out) .. "\n" .. table.concat(lines, "\n")
end
