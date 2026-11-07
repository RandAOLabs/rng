-- beacon_test.lua: drives beacon.lua (the fast tier) compute() the way a node
-- does, slot by slot, carrying the returned base forward. Bundled by
-- run-beacon-tests.mjs, which prepends `F` (fixtures: addresses, BLS
-- signatures, expected values).

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
local slot = 1
local DAY = 86400000

-- A wallet message, signed by `signer` for this beacon (the target door).
local function wallet(signer, fields)
  local body = { target = F.beacon,
                 commitments = { c = { type = "rsa-pss-sha512", committer = signer,
                                       committed = { "target", "action", "data" } },
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

-- Every token Transfer this process sends, in order (sequence, recipient, atoms).
local transfers = {}
local assigned = {}
local function send(body, advance)
  -- The scheduler (dev_scheduler_server write_assignment) assigns a signed
  -- message at most once per process: a copy (same id) is refused with 409
  -- and never computed.
  if body.id ~= nil and body.commitments ~= nil then
    if assigned[body.id] then return { status = 409, error = "Message already scheduled." }, {} end
    assigned[body.id] = true
  end
  clock = clock + (advance or 1000)
  base = compute(base, { body = body, timestamp = clock, process = F.beacon, slot = slot })
  slot = slot + 1
  local out = base.results and base.results.output and base.results.output.data
  local ok, decoded = pcall(json.decode, out or "")
  local outbox = base.results.outbox or {}
  for _, m in pairs(outbox) do
    if m.Action == "Transfer" then
      transfers[#transfers + 1] = { seq = m["X-Transfer-Sequence"], to = m.Recipient, atoms = tonumber(m.Quantity) }
    end
  end
  return ok and decoded or {}, outbox
end

local function info() return json.decode(base.beaconinfo) end
local function genesis(fields) return send(wallet(F.owner, { Action = "Gov.Configure", Data = encode(fields) })) end
local function deployer(fields) fields.Action = fields.Action or "Gov.Configure"; return send(wallet(F.owner, fields)) end
local function dao(fields) return send(delivery(F.dao, fields)) end
local function credit(sender, rng, ref, extra)
  local fields = { Action = "Credit-Notice", Sender = sender, Quantity = tostring(rng), Reference = ref }
  for k, v in pairs(extra or {}) do fields[k] = v end
  return send(delivery(F.token, fields))
end
local function targets(outbox, who)
  for _, m in pairs(outbox) do if m.target == who then return true end end
  return false
end

function runBeaconTests()
  local U = F.unit
  local credited, paidOut = 0, 0

  -- Genesis: the deployer's Gov.Configure, once.
  local r = send(wallet(F.stranger, { Action = "Gov.Configure", Data = F.config }))
  eq("configure refused for non-owner", r.error, "Not authorised")
  r = send(delivery(F.token, { Action = "Credit-Notice", Sender = F.game, Quantity = tostring(3 * U), Reference = "t0" }))
  eq("a credit before genesis is refused", r.error, "Not-Configured")
  r = send(wallet(F.owner, { Action = "Gov.Configure", Data = F.config }))
  eq("genesis sets the committee", #r.committee, 3)
  eq("price is 3 RNG", r.price.fast, 3)
  eq("legacy price key kept", r.price.beacon, 3)
  eq("round message is domain separated", r.roundMessage, "hyperbeam/rng/v1|" .. F.beacon .. "|1")
  eq("the tier is fast", info().tier, "fast")
  eq("on demand, not a heartbeat", info().mode, "on-demand")
  eq("no cadence", info().nextRoundAt, 0)
  r = deployer({ Threshold = "4" })
  eq("invalid reconfiguration refused", r.error, "Invalid-Threshold")
  r = deployer({ Threshold = "1" })
  eq("one key alone is never a quorum", r.error, "Invalid-Threshold")
  eq("failed configuration is atomic", info().threshold, 2)
  r = deployer({ Token = string.rep("z", 43) })
  eq("the token is fixed after genesis", r.error, "Token-Locked")
  r = deployer({ Self = string.rep("z", 43) })
  eq("self is fixed after genesis", r.error, "Token-Locked")
  check("no owner change after refusals", info().gov.dao == "" and info().gov.wallet == true)

  -- No rounds without requests: the committee has nothing to sign.
  r = send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 1, signature = "p1" }) }))
  eq("no partial while nothing is pending", r.error, "Nothing-Pending")
  r = send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 1, signature = F.sig1 }) }))
  eq("no round while nothing is pending", r.error, "Nothing-Pending")
  eq("no round opened by time alone", info().round, 0)
  send(wallet(F.stranger, { Action = "Get-Info" }), 3600000)
  eq("an hour later still no round", info().round, 0)
  eq("nothing locked", info().lockedRound, 0)

  -- Funding: only the token process, once per reference.
  local _, ob = credit(F.game, 13 * U, "t1")
  credited = credited + 13
  eq("credited 13", Beacon.balances[F.game], 13)
  check("no RNG-Funded push", ob["rng-funded"] == nil)
  credit(F.game, 13 * U, "t1")
  eq("same notice twice credits once", Beacon.balances[F.game], 13)
  r = credit(F.game, U, nil)
  eq("notice without a replay reference refused", r.error, "Invalid-Reference")
  r = credit(F.game, U, "not-a-token-ref")
  eq("a reference the token never issues is refused", r.error, "Invalid-Reference")
  r, ob = credit(F.game, U + 7, "t2")
  credited = credited + 1
  eq("whole RNG credited", Beacon.balances[F.game], 14)
  local dust = ob["rng-dust-refund"]
  check("dust goes back through the token", dust and dust.target == F.token and dust.Recipient == F.game
    and dust.Quantity == "7" and dust["X-Transfer-Sequence"] == "1", dust and dust.Quantity)
  send(wallet(F.stranger, { Action = "Credit-Notice", Sender = F.stranger, Quantity = tostring(99 * U),
    Reference = "t90", ["from-process"] = F.token }))
  eq("wallet forging from-process credits nothing", Beacon.balances[F.stranger], nil)
  send({ Action = "Credit-Notice", Sender = F.stranger, Quantity = tostring(99 * U), Reference = "t91",
    ["from-process"] = F.token })
  eq("unsigned from-process credits nothing", Beacon.balances[F.stranger], nil)
  send(wallet(F.sched, { Action = "Credit-Notice", Sender = F.stranger, Quantity = tostring(99 * U), Reference = "t92" }))
  eq("the scheduler alone is nobody", Beacon.balances[F.stranger], nil)
  local ambiguous = wallet(F.owner, { Action = "Gov.Configure", Data = encode({ signerFee = 9 }) })
  ambiguous.commitments.other = { type = "rsa-pss-sha512", committer = F.stranger, committed = { "target" } }
  r = send(ambiguous)
  eq("multiple signer identities are refused", r.error, "Not authorised")

  -- A body-supplied Tags table cannot carry envelope fields: commitments and
  -- from-process come only from the body the node verified.
  local fee = Beacon.signerFee
  r = send(wallet(F.stranger, { Tags = { Action = "Gov.Configure", Data = encode({ signerFee = 9 }),
    commitments = { c = { type = "rsa-pss-sha512", committer = F.owner, committed = { "target" } } } } }))
  eq("owner forged through Tags refused", r.error, "Not authorised")
  eq("forged owner changed nothing", Beacon.signerFee, fee)
  send(wallet(F.stranger, { Tags = { Action = "Credit-Notice", Sender = F.stranger, Quantity = tostring(99 * U),
    Reference = "t93", ["from-process"] = F.token,
    commitments = { c = { type = "rsa-pss-sha512", committer = F.sched, committed = { "target" } } } } }))
  eq("from-process forged through Tags credits nothing", Beacon.balances[F.stranger], nil)
  send(wallet(F.stranger, { Action = "Credit-Notice", Sender = F.stranger, Quantity = tostring(99 * U),
    Reference = "t94", Tags = { FromProcess = F.token, ["From-Process"] = F.token } }))
  eq("from-process forged through Tags in any case credits nothing", Beacon.balances[F.stranger], nil)
  r = send(wallet(F.stranger, { Tags = { Action = "Gov.Pause", ["from-process"] = F.dao } }))
  eq("governor forged through Tags refused", r.error, "Not authorised")
  r = send(wallet(F.stranger, { action = "Get-Info", Tags = { Action = "Gov.Pause" } }))
  eq("a Tags key never overrides a body key in another case", r.error, nil)
  r = send(wallet(F.stranger, { Action = "Get-Info", Tags = "x" }))
  eq("string Tags handled", r.error, nil)

  -- The target door: only messages signed for this beacon.
  local elsewhere = wallet(F.owner, { Action = "Gov.Configure", Data = encode({ signerFee = 9 }) })
  elsewhere.target = string.rep("o", 43)
  r = send(elsewhere)
  eq("message signed for another process refused", r.error, "Refused: not signed for this process")
  local loose = wallet(F.owner, { Action = "Gov.Configure", Data = encode({ signerFee = 9 }) })
  loose.commitments.c.committed = { "action", "data" }
  r = send(loose)
  eq("signature not committing target refused", r.error, "Refused: the signature does not commit target")
  eq("door refusals changed nothing", Beacon.signerFee, fee)

  -- Requests.
  r, ob = send(wallet(F.stranger, { Action = "Request-Random", ["Request-Id"] = "x1" }))
  check("unfunded wallet request refused, no push to the wallet", r.error == "Insufficient-Balance" and next(ob) == nil)
  r, ob = send(delivery(F.stranger, { Action = "Request-Random", ["Request-Id"] = "x1" }))
  check("unfunded process request answered with RNG-Error", ob["rng-error"] and ob["rng-error"].target == F.stranger)
  r = send(delivery(F.game, { Action = "Request-Random", Tier = "timelock", ["Request-Id"] = "x2" }))
  eq("other tiers refused", r.error, "Tier-Unavailable")
  send(delivery(F.game, { Action = "Request-Random", Tier = "fast", ["Request-Id"] = F.req1 }))
  send(delivery(F.game, { Action = "Request-Random", Tier = "beacon", ["Request-Id"] = F.req2 }))
  r, ob = send(delivery(F.game, { Action = "Request-Random", ["Request-Id"] = F.req2 }))
  check("a redelivered request is a no-op, not an error", r.duplicate == true and r.round == 1 and next(ob) == nil)
  eq("balance debited 6", Beacon.balances[F.game], 8)
  eq("two pending", info().pendingCount, 2)
  eq("round message", info().roundMessage, "hyperbeam/rng/v1|" .. F.beacon .. "|1")

  -- Partials are exchanged through the beacon for the open round only.
  r = send(wallet(F.stranger, { Action = "Partial", Data = encode({ round = 1, signature = "aa" }) }))
  eq("partial from non-member refused", r.error, "Not a committee member")
  r = send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 2, signature = "aa" }) }))
  eq("partial for a future round refused", r.error, "Bad-Round")
  send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 1, signature = "p1" }) }))
  eq("first partial locks round 1", info().lockedRound, 1)
  r = send(delivery(F.game, { Action = "Request-Random", ["Request-Id"] = F.req3 }))
  eq("request after partial is queued for round 2", r.round, 2)
  eq("locked round keeps its original request set", info().roundPendingCount, 2)
  eq("third request debited", Beacon.balances[F.game], 5)
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
  eq("round unlocks after finalization", info().lockedRound, 0)
  eq("queued request remains pending", info().pendingCount, 1)
  r = send(wallet(F.stranger, { Action = "Get-Round", Round = "1" }))
  eq("finalized round is queryable", r.value, F.value1)
  eq("queried round carries its signature", r.signature, F.sig1)
  local rec1 = json.decode(base.beaconround)
  check("round 1's record is published in its slot, checkable alone", rec1.round == 1 and rec1.value == F.value1
    and rec1.signature == F.sig1 and rec1.message == "hyperbeam/rng/v1|" .. F.beacon .. "|1"
    and rec1.groupKey == Beacon.groupKey and rec1.requests[1].value == F.out1 and rec1.slot ~= nil)
  local h1 = json.decode(base.beaconhistory).rounds
  check("history maps round 1 to the slot that finalized it", #h1 == 1 and h1[1][1] == 1 and h1[1][2] == rec1.slot)

  -- A VM that lost its globals comes back from the published state.
  Beacon = nil
  Beacon = { rev = 0 }
  send(wallet(F.stranger, { Action = "Get-Info" }))
  eq("state restored after losing globals", info().round, 1)
  eq("balances restored", Beacon.balances[F.game], 5)

  -- A fee change applies to new requests only: round 2's request was charged
  -- 3 and pays out 3, whatever the fee is when it is signed.
  r = deployer({ ["Signer-Fee"] = "5" })
  eq("fees apply at once", r.price.fast, 11)
  check("a fee change is not queued", r.queued == nil and info().govQueue == nil)
  -- No cadence: the next round is signed the moment it has a request.
  send(wallet(F.members[1], { Action = "Round", Data = encode({ round = 2, signature = F.sig2 }) }), 1)
  r = send(wallet(F.members[2], { Action = "Round", Data = encode({ round = 2, signature = F.sig2 }) }), 1)
  eq("round 2 finalized right after round 1", info().round, 2)
  eq("signer 1 paid what was charged", Beacon.accrued[F.members[1]], 1)
  eq("signer 2 paid what was charged", Beacon.accrued[F.members[2]], 3)
  eq("protocol paid what was charged", Beacon.protocolAccrued, 3)
  deployer({ ["Signer-Fee"] = "1" })
  eq("price back to 3", info().price.fast, 3)
  r = send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 3, signature = "p" }) }))
  eq("no heartbeat: round 3 waits for a request", r.error, "Nothing-Pending")

  -- A committee change (a new DKG first) applies at once: no queue, no timelock.
  r = deployer({ Verification = "device" })
  check("committee change applied at once", r.ok == true and r.queued == nil and Beacon.verification == "device", r.error)

  -- Pay and request in one token Transfer (X-Request-Id), here from a wallet:
  -- no push to the wallet; it reads its round from `seen`.
  r, ob = credit(F.wallet, 3 * U, "t3", { ["X-Request-Id"] = "pay-1" })
  credited = credited + 3
  check("pay and request binds round 3", r.round == 3 and r.credited == 3 and r.balance == 0 and next(ob) == nil, r.error)
  eq("the wallet's round is in seen", Beacon.seen[F.wallet .. "|pay-1"], 3)
  r = credit(F.wallet, 3 * U, "t3", { ["X-Request-Id"] = "pay-1" })
  eq("the same notice again is a duplicate", r.duplicate, true)

  -- Production mode: rng@1.0 verifies one group signature, while the beacon
  -- requires threshold published partials and pays their members.
  local savedAo = ao
  ao = { resolve = function(req)
    if req.message == "hyperbeam/rng/v1|" .. F.beacon .. "|3" then
      if req["public-key"] == Beacon.groupKey and req.signature == F.sig3 then
        return "ok", { valid = true, value = F.value3 }
      end
      if req["public-key"] == F.sharePublicKeys[1] and req.signature == F.partial31 then
        return "ok", { valid = true, value = "partial-1" }
      end
      if req["public-key"] == F.sharePublicKeys[2] and req.signature == F.partial32 then
        return "ok", { valid = true, value = "partial-2" }
      end
    end
    return "ok", { valid = false, reason = "verify-failed" }
  end }
  r = send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 3, signature = "bad" }) }))
  eq("device mode rejects invalid partial", r.error, "Bad-Signature")
  send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = 3, signature = F.partial31 }) }))
  send(wallet(F.members[2], { Action = "Partial", Data = encode({ round = 3, signature = F.partial32 }) }))
  r = send(wallet(F.members[3], { Action = "Round", Data = encode({ round = 3, signature = F.fake3 }) }))
  eq("device mode rejects forged group signature", r.error, "Bad-Signature")
  r, ob = send(wallet(F.members[3], { Action = "Round", Data = encode({ round = 3, signature = F.sig3 }) }))
  eq("device mode finalizes from one verified submission", r.value, F.value3)
  check("no RNG-Result pushed to a wallet", not targets(ob, F.wallet))
  eq("the wallet's value derives from the round", rng.hex(rng.sha256("hyperbeam/rng/v1/request|"
    .. Beacon.rounds["3"].value .. "|pay-1")), F.outPay)
  eq("device mode pays published partial member 1", Beacon.accrued[F.members[1]], 2)
  eq("device mode pays published partial member 2", Beacon.accrued[F.members[2]], 4)
  eq("device mode does not pay the submitting non-participant", Beacon.accrued[F.members[3]], 2)
  ao = savedAo

  -- Owners (vendor/gov.lua): the launch wallet bootstraps and renounces; the
  -- DAO's money and code actions wait for Effective-At >= receipt + 24 h
  -- and open the exit hatch; fees, pause and resume apply at once.
  -- Replies are asserted as the raw text the node returns.
  local function out() return base.results.output.data end
  local function govInfo() return info().gov end
  local FLOOR = 86400000
  local function at(extra) return string.format("%d", clock + 1000 + FLOOR + (extra or 0)) end
  local function apply(id) return send(wallet(F.stranger, { Action = "Gov.Apply", ["Gov-Id"] = tostring(id) })) end
  -- White box: made due by moving its Effective-At to now.
  local function due(id) Beacon.gov.pending[tostring(id)].effectiveAt = clock end
  local function enact(fields, pid)
    fields["Effective-At"] = fields["Effective-At"] or at()
    local res, o = send(delivery(pid or F.dao, fields))
    if not res.pending then return res, o end
    due(res.pending.id)
    return apply(res.pending.id)
  end
  dao({ Action = "Gov.Pause" })
  eq("no DAO yet: a DAO delivery is nobody", out(), '{"error":"Not authorised"}')
  send(wallet(F.stranger, { Action = "Gov.Set-Dao", Dao = F.dao }))
  eq("a stranger cannot set the DAO", out(), '{"error":"Not authorised","ok":false}')
  send(wallet(F.stranger, { Action = "Gov.Set-Dao", Dao = F.stranger, ["from-process"] = F.dao }))
  eq("a wallet forging the DAO's from-process cannot set the DAO", out(), '{"error":"Not authorised","ok":false}')
  send(wallet(F.sched, { Action = "Gov.Set-Dao", Dao = F.stranger }))
  eq("the scheduler alone is nobody", out(), '{"error":"Not authorised","ok":false}')
  send({ target = F.beacon, Action = "Gov.Set-Dao", Dao = F.stranger, ["from-process"] = F.dao })
  eq("an unsigned delivery is nobody", out(), '{"error":"Not authorised","ok":false}')
  local hmacOnly = wallet(F.owner, { Action = "Gov.Set-Dao", Dao = F.stranger })
  hmacOnly.commitments.c = nil
  send(hmacOnly)
  check("an hmac committer names nobody", out():find('"ok":true', 1, true) == nil and govInfo().dao == "", out())
  send(wallet(F.owner, { Action = "Gov.Renounce-Wallet" }))
  eq("the wallet cannot renounce before a DAO is set", out(), '{"error":"Set a DAO first","ok":false}')
  send(wallet(F.owner, { Action = "Gov.Set-Dao", Dao = "short" }))
  eq("a DAO must be a process id", out(), '{"error":"Dao must be a 43-character process id","ok":false}')
  send(wallet(F.owner, { Action = "Gov.Set-Dao", Dao = string.rep("a", 42) .. "!" }))
  eq("a DAO id is base64url", out(), '{"error":"Dao must be a 43-character process id","ok":false}')
  check("refusals named no DAO", govInfo().dao == "" and govInfo().wallet == true)
  send(wallet(F.owner, { Action = "Gov.Set-Dao", Dao = F.dao }))
  eq("the wallet sets the DAO", out(), '{"dao":"' .. F.dao .. '","ok":true}')
  check("beaconinfo publishes the owners", base.beaconinfo:find('"gov":{"approved":"","approvedAt":0,"code":"","dao":"' .. F.dao
    .. '","version":0,"wallet":true}', 1, true) ~= nil, base.beaconinfo:match('"gov":%b{}'))
  check("no governor; an empty queue and a shut hatch are published", info().governor == nil
    and #info().govPending == 0 and info().hatch == false and info().exitFloorMs == FLOOR)
  for _, gone in ipairs({ "Gov.Handover", "Gov.Fund", "Gov.Mint" }) do
    send(wallet(F.owner, { Action = gone, Governor = F.dao, ["Gov-Id"] = "1" }))
    eq(gone .. " does not exist", out(), '{"error":"unknown action \'' .. gone .. '\'"}')
  end
  send(wallet(F.owner, { Action = "gov.set_dao", dao = F.dao }))
  eq("the verb and tag names fold case, - and _", out(), '{"dao":"' .. F.dao .. '","ok":true}')
  local twice = wallet(F.owner, { Action = "Gov.Set-Dao", Dao = F.dao, dao = F.stranger })
  send(twice)
  eq("one tag spelled twice with two values is no tag", out(), '{"error":"Dao must be a 43-character process id","ok":false}')
  eq("the DAO is unchanged", govInfo().dao, F.dao)

  -- Fees are harmless: on receipt. The committee and the fee share are money.
  eq("the DAO's address as a wallet is nobody", send(wallet(F.dao, { Action = "Gov.Pause" })).error, "Not authorised")
  eq("a wallet forging the DAO's from-process is nobody",
    send(wallet(F.stranger, { Action = "Gov.Pause", ["from-process"] = F.dao })).error, "Not authorised")
  eq("another process is nobody", send(delivery(F.game, { Action = "Gov.Pause" })).error, "Not authorised")
  r = dao({ Action = "Gov.Configure", ["Signer-Fee"] = "2", protocol_fee = "2" })
  check("the DAO sets fees by tag", r.price and r.price.fast == 6, r.error)
  eq("data is the wallet's only", dao({ Action = "Gov.Configure", Data = encode({ signerFee = 9 }) }).signerFee, 2)
  eq("fee bounds", dao({ Action = "Gov.Configure", ["Signer-Fee"] = "0" }).error, "Bad-Parameter")
  r = deployer({ ["Signer-Fee"] = "3" })
  check("the wallet still governs beside the DAO", r.ok == true and r.signerFee == 3, r.error)
  dao({ Action = "Gov.Configure", ["Signer-Fee"] = "2" })
  local newCommittee = { Action = "Gov.Configure", Committee = encode({ F.members[1], F.members[2] }), Threshold = "2",
    ["Group-Key"] = F.groupKey2, ["Share-Public-Keys"] = encode({ F.sharePublicKeys[1], F.sharePublicKeys[2] }) }
  eq("committee bounds checked on proposal", dao({ Action = "Gov.Configure", Threshold = "4" }).error, "Invalid-Threshold")
  eq("Exit-Now with the hatch shut", send(wallet(F.members[3], { Action = "Exit-Now" })).error, "Hatch-Closed")
  r = dao(newCommittee)
  check("a committee change without Effective-At is refused", r.error == "Effective-At-Required" and #info().committee == 3, encode(r))
  newCommittee["Effective-At"] = at(-1)
  eq("a committee change short of the floor is refused", dao(newCommittee).error, "Effective-At-Too-Soon")
  newCommittee["Effective-At"] = at()
  r = dao(newCommittee)
  local cid = r.pending and r.pending.id
  check("pending: the committee unchanged, published, the hatch open", cid and #info().committee == 3
    and info().govPending[1].id == cid and info().govPending[1].class == "money" and info().hatch == true, encode(r))
  eq("apply before due refused", apply(cid).error, "Too-Early")
  -- The exit hatch: member 3 leaves at once, with its earnings.
  eq("a stranger is no member", send(wallet(F.stranger, { Action = "Exit-Now" })).error, "Not a committee member")
  r, ob = send(wallet(F.members[3], { Action = "Exit-Now" }))
  paidOut = paidOut + 2
  check("hatch exit: out of the committee, earnings paid at once", r.exited == true and r.claimed == 2
    and ob["rng-claim"] and ob["rng-claim"].Recipient == F.members[3] and ob["rng-claim"].Quantity == string.format("%d", 2 * U)
    and Beacon.committee[F.members[3]] == nil and Beacon.accrued[F.members[3]] == 0 and #info().committee == 2, encode(r))
  due(cid)
  r = apply(cid)
  check("once due anyone applies the new committee; the hatch closes", r.applied == cid and #info().committee == 2
    and info().groupKey == F.groupKey2 and info().hatch == false, encode(r))
  r = dao({ Action = "Gov.Configure", ["Protocol-Fee"] = "2", ["Effective-At"] = string.format("%d", clock + 5000) })
  check("a later harmless change waits but opens no hatch", r.pending and r.pending.class == "harmless" and info().hatch == false, encode(r))
  dao({ Action = "Gov.Cancel", ["Gov-Id"] = tostring(r.pending.id) })
  eq("cancelled", #info().govPending, 0)
  eq("a stranger cannot cancel", send(wallet(F.stranger, { Action = "Gov.Cancel", ["Gov-Id"] = "1" })).error, "Not authorised")
  for _, f in ipairs({ { Action = "Gov.Configure", Threshold = "2" }, { Action = "Gov.Claim-Protocol", Recipient = F.owner },
                       { Action = "Gov.Set-Dao", Dao = F.stranger } }) do
    local r1 = dao(f)
    f["Effective-At"] = at(-1)
    local r2 = dao(f)
    check(f.Action .. ": refused without Effective-At or short of the floor", r1.error == "Effective-At-Required"
      and r2.error == "Effective-At-Too-Soon", encode({ r1, r2 }))
  end
  -- Threshold 1 of 2 is refused by the bounds anyway: checked first.
  eq("one key alone is never a quorum", dao({ Action = "Gov.Configure", Threshold = "1", ["Effective-At"] = at() }).error, "Invalid-Threshold")
  check("nothing pending", #info().govPending == 0 and govInfo().dao == F.dao)
  for _, gone in ipairs({ "Configure", "Claim-Protocol", "Admin.Mint", "Mint", "Faucet", "Gov.Clear-Guardian" }) do
    eq(gone .. " does not exist", dao({ Action = gone }).error, "unknown action '" .. gone .. "'")
  end

  -- The DAO executes a proposal once.
  check("proposal executes", dao({ Action = "Gov.Pause", ["X-Dao-Proposal"] = "7" }).paused == true)
  dao({ Action = "Gov.Resume", ["X-Dao-Proposal"] = "8" })
  r = dao({ Action = "Gov.Pause", ["X-Dao-Proposal"] = "7" })
  check("the same proposal again is a no-op", r.duplicate == true and not Beacon.paused, encode(r))
  r = send(wallet(F.owner, { Action = "Gov.Pause", ["X-Dao-Proposal"] = "7" }))
  check("the wallet's message is no DAO proposal", r.paused == true and Beacon.paused, encode(r))
  deployer({ Action = "Gov.Resume" })

  -- Pause: no new requests; a paid one-message request keeps its credit.
  dao({ Action = "Gov.Pause" })
  eq("paused: mode", info().mode, "paused")
  eq("paused: no new requests", send(delivery(F.game, { Action = "Request-Random", ["Request-Id"] = "p1" })).error, "Paused")
  r = credit(F.wallet, 6 * U, "t4", { ["X-Request-Id"] = "pay-2" })
  credited = credited + 6
  check("pay-and-request refused while paused: the credit stays", r.error == "Paused" and Beacon.balances[F.wallet] == 6, r.error)
  dao({ Action = "Gov.Resume" })
  r, ob = send(wallet(F.wallet, { Action = "Withdraw" }))
  paidOut = paidOut + 6
  check("withdraw pays the wallet back", ob["rng-withdraw"] and ob["rng-withdraw"].Recipient == F.wallet
    and ob["rng-withdraw"].Quantity == string.format("%d", 6 * U), r.error)

  -- The protocol's share leaves through Gov.Claim-Protocol: money, after the floor.
  eq("not to the DAO", dao({ Action = "Gov.Claim-Protocol", Recipient = F.dao }).error, "Bad-Recipient")
  eq("not to the token", dao({ Action = "Gov.Claim-Protocol", Recipient = F.token }).error, "Bad-Recipient")
  eq("not to itself", dao({ Action = "Gov.Claim-Protocol", Recipient = F.beacon }).error, "Bad-Recipient")
  eq("a stranger cannot claim", send(wallet(F.stranger, { Action = "Gov.Claim-Protocol", Recipient = F.stranger })).error,
    "Not authorised")
  r, ob = enact({ Action = "Gov.Claim-Protocol", Recipient = F.owner })
  paidOut = paidOut + 4
  eq("protocol fees paid once applied (raw)", out(), '{"applied":' .. r.applied .. ',"claimed":4,"recipient":"' .. F.owner
    .. '","verb":"Gov.Claim-Protocol"}')
  check("the claim is one Transfer", ob["rng-protocol"] and ob["rng-protocol"].Recipient == F.owner
    and ob["rng-protocol"].Quantity == string.format("%d", 4 * U) and Beacon.protocolAccrued == 0)
  r, ob = enact({ Action = "Gov.Claim-Protocol", Recipient = F.owner })
  check("nothing accrued: no transfer", r.claimed == 0 and next(ob) == nil, encode(r))

  -- Code: an owner approves a root; the wallet installs code directly;
  -- anyone uploads approved code. Installed code keeps the state.
  local roundBefore = info().round
  local code1 = "local prev = compute\nUpgradeMarker = 1\nfunction compute(b, r, o) return prev(b, r, o) end"
  send(wallet(F.stranger, { Action = "Gov.Upgrade", Data = code1 }))
  eq("a stranger cannot install code", out(), '{"error":"No approved code","ok":false}')
  send(wallet(F.stranger, { Action = "Gov.Approve-Code", ["Code-Root"] = Gov.rootOf(code1) }))
  eq("a stranger cannot approve code", out(), '{"error":"Not authorised","ok":false}')
  send(wallet(F.owner, { Action = "Gov.Upgrade", Data = "this is not lua" }))
  check("code that does not load is refused, nothing changes", out():find('"ok":false', 1, true) ~= nil
    and govInfo().version == 0 and govInfo().code == "", out())
  send(wallet(F.owner, { Action = "Gov.Upgrade", Data = "UpgradeMarker = 9" }))
  check("code without a new compute is refused and undone", out():find('"error":"the code must be a full bundle', 1, true) ~= nil
    and UpgradeMarker == nil, out())
  send(wallet(F.owner, { Action = "Gov.Upgrade", Data = code1 }))
  eq("the wallet installs code directly", out(), '{"installed":"' .. Gov.rootOf(code1) .. '","ok":true,"version":1}')
  check("the new code runs on the old state", UpgradeMarker == 1 and info().round == roundBefore
    and govInfo().code == Gov.rootOf(code1) and govInfo().version == 1 and govInfo().dao == F.dao)
  send(wallet(F.stranger, { Action = "Gov.Upgrade", Data = code1 }))
  eq("the running code again changes nothing", out(), '{"error":"No approved code","ok":false}')

  -- Every Gov.* needs the scheduler's time, never older than the last one.
  local function sendAt(body, ts)
    base = compute(base, { body = body, timestamp = ts, process = F.beacon, slot = slot })
    slot = slot + 1
    return json.decode(base.results.output.data)
  end
  eq("a Gov.* with no time is refused", sendAt(delivery(F.dao, { Action = "Gov.Pause" }), nil).error, "No-Time")
  eq("Exit-Now with no time is refused", sendAt(wallet(F.members[1], { Action = "Exit-Now" }), nil).error, "No-Time")
  eq("a Gov.* older than the last is refused", sendAt(delivery(F.dao, { Action = "Gov.Pause" }), clock - 5000).error,
    "Time-Went-Back")
  check("so nothing changed", not Beacon.paused and Beacon.committee[F.members[1]] ~= nil)
  -- The wallet cannot renounce over a queued action.
  local qid = dao({ Action = "Gov.Claim-Protocol", Recipient = F.owner, ["Effective-At"] = at() }).pending.id
  send(wallet(F.owner, { Action = "Gov.Renounce-Wallet" }))
  eq("no renounce over a non-empty queue", out(), '{"error":"Gov-Queue-Not-Empty","ok":false}')
  dao({ Action = "Gov.Cancel", ["Gov-Id"] = tostring(qid) })

  -- Renounce: one way, the wallet's alone; then only the DAO governs.
  dao({ Action = "Gov.Renounce-Wallet" })
  eq("the DAO cannot renounce the wallet", out(), '{"error":"Not authorised","ok":false}')
  send(wallet(F.stranger, { Action = "Gov.Renounce-Wallet" }))
  eq("a stranger cannot renounce the wallet", out(), '{"error":"Not authorised","ok":false}')
  send(wallet(F.owner, { Action = "Gov.Renounce-Wallet" }))
  eq("the wallet renounces", out(), '{"ok":true,"wallet":false}')
  check("beaconinfo shows no wallet", govInfo().wallet == false and govInfo().dao == F.dao)
  eq("the wallet is locked out of Configure", deployer({ ["Signer-Fee"] = "1" }).error, "Not authorised")
  for _, f in ipairs({ { Action = "Gov.Pause" }, { Action = "Gov.Claim-Protocol", Recipient = F.owner },
      { Action = "Gov.Cancel", ["Gov-Id"] = "code" }, { Action = "Gov.Configure", Threshold = "2", ["Effective-At"] = at() } }) do
    eq("the renounced wallet: " .. f.Action, send(wallet(F.owner, f)).error, "Not authorised")
  end
  send(wallet(F.owner, { Action = "Gov.Approve-Code", ["Code-Root"] = string.rep("b", 64) }))
  eq("the renounced wallet cannot approve code", out(), '{"error":"Not authorised","ok":false}')
  send(wallet(F.owner, { Action = "Gov.Set-Dao", Dao = F.owner }))
  eq("the wallet cannot take the DAO seat", out(), '{"error":"Not authorised","ok":false}')
  send(wallet(F.owner, { Action = "Gov.Renounce-Wallet" }))
  eq("renouncing twice is refused", out(), '{"error":"Not authorised","ok":false}')
  local code2 = "local prev = compute\nUpgradeMarker = 2\nfunction compute(b, r, o) return prev(b, r, o) end"
  send(wallet(F.owner, { Action = "Gov.Upgrade", Data = code2 }))
  eq("the renounced wallet cannot install code", out(), '{"error":"No approved code","ok":false}')

  -- The DAO approves; anyone uploads, in parts and in any order.
  local partA, partB = code2:sub(1, 30), code2:sub(31)
  local manifest = Sha256.hex(partA) .. "\n" .. Sha256.hex(partB)
  local root2 = Sha256.hex(manifest)
  dao({ Action = "Gov.Approve-Code", ["Code-Root"] = "nothex" })
  eq("a root is 64 lowercase hex", out(), '{"error":"Code-Root must be 64 lowercase hex","ok":false}')
  dao({ Action = "Gov.Approve-Code", ["Code-Root"] = root2 })
  eq("the DAO's approval needs Effective-At", out(), '{"error":"Effective-At-Required","ok":false}')
  local codeAt = at()
  dao({ Action = "Gov.Approve-Code", ["Code-Root"] = root2, ["Effective-At"] = codeAt })
  eq("the DAO approves a root for its Effective-At", out(), '{"approved":"' .. root2 .. '","effectiveAt":' .. codeAt .. ',"ok":true}')
  check("the code approval opens the hatch", info().hatch == true and info().govPending[1].id == "code")
  send(wallet(F.stranger, { Action = "Gov.Upgrade", Data = code1 .. "\n" }))
  check("code for another root is refused", out():find('"error":"Code does not match the approved root"', 1, true) ~= nil, out())
  send(wallet(F.stranger, { Action = "Gov.Upgrade", Part = "0", Data = manifest }))
  eq("a stranger starts the approved upload", out(), '{"have":0,"ok":true,"part":0,"parts":2,"root":"' .. root2 .. '"}')
  send(wallet(F.stranger, { Action = "Gov.Upgrade", Part = "1", Data = partB }))
  check("a wrong part is refused", out():find('"error":"Part does not match the manifest"', 1, true) ~= nil, out())
  send(wallet(F.stranger, { Action = "Gov.Upgrade", Part = "2", Data = partB }))
  eq("part 2 first", out(), '{"have":1,"ok":true,"part":2,"parts":2}')
  send(wallet(F.stranger, { Action = "Gov.Upgrade", Part = "1", Data = partA }))
  eq("attack: the last part before Effective-At is kept, not installed", out(), '{"effectiveAt":' .. codeAt
    .. ',"error":"Not-Yet-Effective","have":2,"ok":false,"parts":2}')
  check("the old code still runs", UpgradeMarker == 1)
  GovState.approvedAt = clock -- white box: now due
  send(wallet(F.stranger, { Action = "Gov.Upgrade", Part = "0", Data = manifest }))
  eq("once due, the manifest sent again installs the kept parts", out(), '{"installed":"' .. root2 .. '","ok":true,"version":2}')
  check("the DAO's code runs; the approval is spent", UpgradeMarker == 2 and govInfo().approved == ""
    and govInfo().code == root2 and govInfo().version == 2)

  -- The DAO hands its seat to another DAO; the old one is nobody after.
  local dao2 = string.rep("d", 43)
  r = dao({ Action = "Gov.Set-Dao", Dao = dao2, ["Effective-At"] = at() })
  check("the DAO's Set-Dao waits", r.pending ~= nil and govInfo().dao == F.dao, encode(r))
  due(r.pending.id)
  apply(r.pending.id)
  eq("the DAO names its successor, once due", out(), '{"applied":' .. r.pending.id .. ',"dao":"' .. dao2
    .. '","ok":true,"verb":"Gov.Set-Dao"}')
  eq("the old DAO is nobody", dao({ Action = "Gov.Pause" }).error, "Not authorised")
  r = enact({ Action = "Gov.Set-Dao", Dao = F.dao }, dao2)
  eq("the new DAO acts", r.dao, F.dao)
  local keptId = dao({ Action = "Gov.Claim-Protocol", Recipient = F.owner, ["Effective-At"] = at() }).pending.id

  -- A cold VM: the owners come back from beaconstate; installed code does
  -- not (the spawn module runs), so its root comes back approved.
  local savedBeacon = Beacon
  Beacon = { rev = 0 }
  send(wallet(F.stranger, { Action = "Get-Info" }))
  check("a rebuilt VM keeps the renounced wallet and the DAO", govInfo().wallet == false and govInfo().dao == F.dao, encode(govInfo()))
  check("installed code comes back approved, not running", govInfo().code == "" and govInfo().approved == root2
    and govInfo().version == 2, encode(govInfo()))
  check("a rebuilt VM keeps the pending actions", info().govPending[1] and info().govPending[1].id == keptId
    and info().hatch == true, encode(info().govPending))
  dao({ Action = "Gov.Cancel", ["Gov-Id"] = tostring(keptId) })
  eq("the wallet stays locked out after a rebuild", deployer({ ["Signer-Fee"] = "1" }).error, "Not authorised")
  check("the rebuilt state is the same state", Beacon.transferSeq == savedBeacon.transferSeq
    and info().round == savedBeacon.round)
  local st = json.decode(base.beaconstate)
  st.owners = nil
  base.beaconstate, base.beaconrev = encode(st), string.format("%d", Beacon.rev + 1)
  Beacon = { rev = 0 }
  send(wallet(F.owner, { Action = "Gov.Set-Dao", Dao = F.owner }))
  eq("a published state with no owners re-arms nobody", out(), '{"error":"Not authorised","ok":false}')
  check("and has no wallet", govInfo().wallet == false, encode(govInfo()))
  Beacon.owners = { dao = F.dao, wallet = false, approved = "", approvedAt = 0, code = { sha = "", version = 2 } }
  GovState = Beacon.owners
  -- Signers claim their own earnings; a handler that throws leaves no trace.
  local seqBefore = Beacon.transferSeq
  local realEncode = encode
  encode = function(v) if type(v) == "table" and v.claimed then error("boom") end return realEncode(v) end
  local nTransfers = #transfers
  r, ob = send(wallet(F.members[2], { Action = "Claim" }))
  encode = realEncode
  check("a failed handler rolls back", r.error ~= nil and next(ob) == nil and #transfers == nTransfers
    and Beacon.transferSeq == seqBefore and Beacon.accrued[F.members[2]] == 4, r.error)
  r, ob = send(wallet(F.members[2], { Action = "Claim" }))
  paidOut = paidOut + 4
  local t = ob["rng-claim"]
  check("claim pays out through the token", t and t.target == F.token and t.Recipient == F.members[2]
    and t.Quantity == string.format("%d", 4 * U) and t["X-Transfer-Sequence"] == string.format("%d", seqBefore + 1),
    t and t["X-Transfer-Sequence"])
  eq("accrued reset", Beacon.accrued[F.members[2]], 0)
  eq("claim twice pays nothing", send(wallet(F.members[2], { Action = "Claim" })).error, "Nothing-To-Claim")

  -- Abandon: a round the committee does not sign within abandonAfterMs is
  -- refunded (exactly what was charged), processes told, signers unpaid.
  local function count(t) local n = 0 for _ in pairs(t) do n = n + 1 end return n end
  local function tick(ms) return send(wallet(F.stranger, { Action = "Get-Info" }), ms) end
  credit(F.game, 3000 * U, "t5")
  credited = credited + 3000
  local bal0 = Beacon.balances[F.game]
  local earned = { Beacon.accrued[F.members[1]], Beacon.accrued[F.members[2]], Beacon.protocolAccrued }
  local open = info().nextRound
  local price = info().price.fast
  r = send({ target = F.beacon, Action = "Request-Random", ["Request-Id"] = "ab-unsigned" })
  check("an unsigned request is refused uncharged", r.error == "Unsigned" and Beacon.balances[F.game] == bal0, r.error)
  r = send(delivery(F.game, { Action = "Request-Random", ["Request-Id"] = "ab-1" }))
  check("bound to the open round", r.round == open and Beacon.balances[F.game] == bal0 - price, r.error)
  eq("abandonAt published", info().abandonAt, clock + 1800000)
  tick(1700000)
  eq("not refunded before abandonAfterMs", Beacon.balances[F.game], bal0 - price)
  r, ob = tick(100000)
  local note = ob["rng-abandoned-" .. open .. "-1"]
  check("abandoned: refunded in full", Beacon.balances[F.game] == bal0 and info().pendingCount == 0, Beacon.balances[F.game])
  check("the requesting process is told Round-Abandoned", note and note.target == F.game
    and json.decode(note.Data).error == "Round-Abandoned" and json.decode(note.Data).requestId == "ab-1")
  check("an unlocked round keeps its number", info().round == open - 1 and info().nextRound == open)
  local rec = json.decode(base.beaconabandoned)[1]
  check("the abandon is published in its slot", rec.round == open and rec.slot == slot - 1
    and rec.refunded[1].requestId == "ab-1", base.beaconround)
  local hist = json.decode(base.beaconhistory).rounds
  check("history maps the round to its slot", hist[#hist][1] == open and hist[#hist][2] == slot - 1 and hist[#hist][3] == "abandoned")
  check("signers are paid nothing for it", Beacon.accrued[F.members[1]] == earned[1]
    and Beacon.accrued[F.members[2]] == earned[2] and Beacon.protocolAccrued == earned[3])

  -- Once its value is computable from published partials, a locked round
  -- waits ABANDON_CAP_MS (no selective abort), and its number is skipped.
  local savedAo2 = ao
  ao = { resolve = function() return "ok", { valid = true, value = "x" } end }
  r = send(delivery(F.game, { Action = "Request-Random", ["Request-Id"] = "ab-2" }))
  eq("the kept number takes the next request", r.round, open)
  send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = open, signature = "q1" }) }))
  send(wallet(F.members[2], { Action = "Partial", Data = encode({ round = open, signature = "q2" }) }))
  tick(1900000)
  check("a knowable locked round is not abandoned at abandonAfterMs", info().pendingCount == 1 and info().lockedRound == open)
  r, ob = tick(7 * DAY)
  check("abandoned 7 days after it locked", info().pendingCount == 0 and Beacon.balances[F.game] == bal0
    and ob["rng-abandoned-" .. open .. "-1"] ~= nil)
  check("its number is skipped", info().round == open and json.decode(base.beaconabandoned)[1].skipped == true)
  r = send(wallet(F.stranger, { Action = "Get-Round", Round = tostring(open) }))
  check("Get-Round points at the slot", r.error == "Round-Not-Retained" and r.abandoned == true and r.slot ~= nil, encode(r))
  r = send(delivery(F.game, { Action = "Request-Random", ["Request-Id"] = "ab-3" }))
  eq("the next request binds past the skipped number", r.round, open + 1)
  send(wallet(F.members[1], { Action = "Partial", Data = encode({ round = open + 1, signature = "q1" }) }))
  r = send(wallet(F.members[1], { Action = "Round", Data = encode({ round = open, signature = F.sig3 }) }))
  eq("a skipped round cannot be signed", r.error, "Bad-Round")
  tick(1900000)
  check("one partial reveals nothing: abandoned at abandonAfterMs, number skipped",
    info().pendingCount == 0 and info().round == open + 1 and Beacon.balances[F.game] == bal0)
  ao = savedAo2
  eq("abandon window bounded", dao({ Action = "Gov.Configure", ["Abandon-After-Ms"] = "59999" }).error, "Bad-Parameter")
  eq("nor past the cap", dao({ Action = "Gov.Configure", ["Abandon-After-Ms"] = "604800001" }).error, "Bad-Parameter")
  r = dao({ Action = "Gov.Configure", ["Abandon-After-Ms"] = "120000" })
  check("the DAO sets the abandon window", r.ok == true and r.abandonAfterMs == 120000, r.error)

  -- Bounds. Request ids live GUARD_MS of scheduler time: after 400 requests
  -- 30 s apart `seen` holds about 20. A copy of a forgotten one's signed
  -- message is the scheduler's to refuse (409 here).
  local maxSeen, firstMsg = 0, nil
  for i = 1, 400 do
    local m = delivery(F.game, { Action = "Request-Random", ["Request-Id"] = "b-" .. i, id = "msg-b-" .. i })
    firstMsg = firstMsg or m
    send(m, 30000)
    maxSeen = math.max(maxSeen, count(Beacon.seen))
  end
  check("seen stays within the guard window", maxSeen <= 25 and count(Beacon.seen) == #Beacon.seenQueue, maxSeen)
  check("pending stays bounded by the abandon window", info().pendingCount <= 5, info().pendingCount)
  check("a forgotten id is gone", Beacon.seen[F.game .. "|b-1"] == nil)
  local before = Beacon.balances[F.game]
  r = send(firstMsg)
  check("a replayed signed message is refused by the scheduler, uncharged", r.status == 409 and Beacon.balances[F.game] == before, r.error)
  r = send(delivery(F.game, { Action = "Request-Random", ["Request-Id"] = "b-400" }))
  check("a remembered id is a duplicate", r.duplicate == true and Beacon.balances[F.game] == before)
  check("history bounded", #json.decode(base.beaconhistory).rounds <= 1024 and #Beacon.history > 100, #Beacon.history)
  check("rounds bounded", count(Beacon.rounds) <= 32)

  -- The window is scheduler time, whatever the message rate: dense slots
  -- (1500 in 15 s) keep an id remembered, 10 minutes forget it.
  local function tick(ms) return send(wallet(F.stranger, { Action = "Get-Info" }), ms) end
  r = send(delivery(F.game, { Action = "Request-Random", ["Request-Id"] = "w-1" }))
  check("w-1 bound", r.round ~= nil, r.error)
  for _ = 1, 1500 do tick(10) end
  before = Beacon.balances[F.game]
  r = send(delivery(F.game, { Action = "Request-Random", ["Request-Id"] = "w-1" }))
  check("dense slots: the same id within the window is a duplicate, uncharged",
    r.duplicate == true and Beacon.balances[F.game] == before, r.error)
  tick(600001)
  check("past GUARD_MS of scheduler time it is forgotten", Beacon.seen[F.game .. "|w-1"] == nil)

  -- Token references: the newest 1000, older ones below the floor.
  for i = 1, 1500 do credit(F.game, U, "t" .. (100 + i), nil) end
  credited = credited + 1500
  before = Beacon.balances[F.game]
  check("credited stays within CREDIT_KEEP", count(Beacon.credited) <= 1000 and Beacon.creditFloor >= 500, count(Beacon.credited))
  r = credit(F.game, U, "t101")
  check("a pruned reference is still a duplicate", r.duplicate == true and Beacon.balances[F.game] == before)
  r = credit(F.game, U, "t1600")
  check("a kept reference is a duplicate", r.duplicate == true and Beacon.balances[F.game] == before)

  -- Executed DAO proposals: the newest 256, older numeric ids below a floor.
  for i = 1, 300 do dao({ Action = "Gov.Resume", ["X-Dao-Proposal"] = tostring(1000 + i) }) end
  check("executed stays within EXECUTED_KEEP", count(Beacon.gov.executed) <= 256
    and #Beacon.gov.executedOrder <= 256, count(Beacon.gov.executed))
  r = dao({ Action = "Gov.Pause", ["X-Dao-Proposal"] = "1001" })
  check("a pruned proposal is still a duplicate", r.duplicate == true and not Beacon.paused, encode(r))
  r = dao({ Action = "Gov.Pause", ["X-Dao-Proposal"] = "1300" })
  check("a kept proposal is a duplicate", r.duplicate == true and not Beacon.paused)

  -- A cold VM restores the history from its own key (it is not in beaconstate).
  local nHist = #Beacon.history
  check("history kept out of beaconstate", json.decode(base.beaconstate).history == nil)
  Beacon = { rev = 0 }
  tick(1)
  eq("history restored", #Beacon.history, nHist)

  -- Every Transfer carries the next X-Transfer-Sequence, with no gaps.
  local contiguous = #transfers >= 4
  for i, x in ipairs(transfers) do if x.seq ~= string.format("%d", i) then contiguous = false end end
  check("transfer sequence 1..n with no gaps", contiguous, #transfers)
  eq("published sequence", info().transferSeq, #transfers)

  -- Conservation: every RNG credited is held, owed or paid out.
  local held = Beacon.protocolAccrued
  for _, v in pairs(Beacon.balances) do held = held + v end
  for _, v in pairs(Beacon.accrued) do held = held + v end
  for _, list in pairs(Beacon.pending) do for _, p in ipairs(list) do held = held + p.charged end end
  eq("credited = held + paid out", credited, held + paidOut)

  lines[#lines + 1] = passed .. " passed, " .. failed .. " failed"
  return table.concat(lines, "\n")
end

function rngtest()
  local ok, out = pcall(runBeaconTests)
  if ok then return out end
  return "ERROR " .. tostring(out) .. "\n" .. table.concat(lines, "\n")
end
