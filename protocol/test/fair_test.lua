-- fair_test.lua: drives fair/fair.lua's compute() (and lib/fair.lua embedded)
-- slot by slot. Bundled by run-fair-tests.mjs after fixtures F.

local passed, failed, lines = 0, 0, {}
local function check(name, ok, detail)
  if ok then passed = passed + 1 else
    failed = failed + 1
    lines[#lines + 1] = "FAIL " .. name .. (detail ~= nil and (": " .. tostring(detail)) or "")
  end
end
local function eq(name, got, want) check(name, got == want, "got " .. tostring(got) .. ", want " .. tostring(want)) end
local function count(t) local n = 0; for _ in pairs(t or {}) do n = n + 1 end; return n end

local SELF = F.self
local base = { ["scheduler-location"] = F.sched, process = { commitments = { p = { type = "rsa-pss-sha512", committer = F.owner } } } }
local clock = 1700000000000

local function wallet(signer, fields)
  local body = { target = SELF,
    commitments = { c = { type = "rsa-pss-sha256", committer = signer, committed = { "target", "data", "action" } } } }
  for k, v in pairs(fields) do body[k] = v end
  return body
end
local function delivery(pid, fields)
  local body = wallet(F.sched, fields)
  body["from-process"] = pid
  return body
end
-- The ledger seen from outside: atoms credited in, atoms the process sent out
-- (top-ups, refunds, withdrawals) and every X-Transfer-Sequence it used.
local fundedIn, paidOut, seqs = 0, 0, {}
local slotNo = 0
local assigned = {}
local function send(body, advance)
  -- The scheduler (dev_scheduler_server write_assignment) assigns a signed
  -- message at most once per process: a copy (same id) is refused with 409
  -- and never computed.
  if body.id ~= nil and body.commitments ~= nil then
    if assigned[body.id] then return { status = 409, error = "Message already scheduled." }, {} end
    assigned[body.id] = true
  end
  clock = clock + (advance or 100)
  slotNo = slotNo + 1
  base = compute(base, { body = body, timestamp = clock, process = SELF, slot = slotNo })
  local ok, d = pcall(json.decode, base.results.output.data or "")
  for _, m in pairs(base.results.outbox or {}) do
    if m.Action == "Transfer" then
      paidOut = paidOut + math.tointeger(tonumber(m.Quantity))
      seqs[#seqs + 1] = math.tointeger(tonumber(m["X-Transfer-Sequence"]))
    end
  end
  return ok and d or {}, base.results.outbox or {}
end
local ref = 0
--- A token Credit-Notice paying `atoms` for `game` (X-Fair-Game).
local function fund(game, atoms, o)
  o = o or {}
  ref = ref + 1
  local f = { Action = "Credit-Notice", Sender = o.sender or F.payer, Quantity = tostring(atoms),
    Reference = o.reference or ("t" .. ref) }
  if game then f[o.tag or "X-Fair-Game"] = game end
  local body = o.body or delivery(o.from or F.token, f)
  if o.body then for k, v in pairs(f) do body[k] = v end end
  local r, ob = send(body)
  for _, k in ipairs({ "credited", "refunded" }) do
    if type(r[k]) == "number" and r[k] > 0 then fundedIn = fundedIn + math.tointeger(r[k]) end
  end
  return r, ob
end
local function accounts() return json.decode(base.fairaccounts or "{}") end
local function held()
  local n = 0
  for _, a in pairs(accounts()) do
    check("no negative balance", a.balance >= 0 and a.reserved >= 0)
    n = n + math.tointeger(a.balance) + math.tointeger(a.reserved)
  end
  return n
end
local function sessions(game) return (json.decode(base.fairsessions)[game or F.game]) or {} end
local function batches() return json.decode(base.fairbatches) end
local function sessionOf(name, player, game)
  for _, s in ipairs(sessions(game)) do if s.session == name and (not player or s.player == player) then return s end end
end
--- The game authorizes the player's key for the session (Fair.Open).
local function open(player, session, game)
  return send(delivery(game or F.game, { Action = "Fair.Open", Session = session, Player = player }))
end
local function commit(player, session, c, noOpen)
  if not noOpen then open(player, session) end
  return send(wallet(player, { Action = "Fair.Commit", Game = F.game, Session = session, Commit = c }))
end
local function result(requestId, roundValue, from, advance)
  local value = rng.hex(rng.sha256("hyperbeam/rng/any-honest/v1/request|" .. roundValue .. "|" .. SELF .. "|" .. requestId))
  local body = { round = 7, tier = "any-honest", value = roundValue,
    results = { { requestId = requestId, round = 7, value = value } } }
  return send(delivery(from or F.beacon, { Action = "RNG-Result", Data = encode(body) }), advance)
end
local function rngError(requestId, err) return send(delivery(F.beacon, { Action = "RNG-Error",
  Data = encode({ error = err or "Insufficient-Balance", requestId = requestId }) })) end
local function reveal(signer, session, secret, player)
  return send(wallet(signer, { Action = "Fair.Reveal", Game = F.game, Session = session, Secret = secret, Player = player }))
end
local function expire(session, player, advance)
  return send(wallet(F.stranger, { Action = "Fair.Expire", Game = F.game, Session = session, Player = player }), advance)
end
local function configure(d, who) return send(wallet(who or F.owner, { Action = "Fair.Configure", Data = encode(d) })) end

local function runFairTests()
  local r, ob

  -- Hashes match the JS vectors (the browser client's contract).
  local V = F.vector
  eq("commit vector", fair.commitHash(V.game, V.session, V.secret), V.commit)
  eq("session value vector", fair.sessionValue(V.vb, V.game, V.session), V.v)
  eq("final vector", fair.finalValue(V.v, V.secret), V.final)
  eq("forfeit vector", fair.forfeitValue(V.v), V.forfeit)
  -- Domain separation: the four hashes of the same inputs all differ.
  local seen = {}
  for _, x in ipairs({ fair.commitHash(V.game, V.session, V.vb), fair.sessionValue(V.vb, V.game, V.session),
                       fair.finalValue(V.vb, V.vb), fair.forfeitValue(V.vb) }) do seen[x] = true end
  eq("domains separated", count(seen), 4)

  -- Open to any game, and each game pays for its own draws.
  eq("no session before token and price are set", open(F.p1, "early0").error, "Not-Configured")
  eq("token checked", configure({ token = "short" }).error, "Bad-Parameter")
  eq("requestPrice checked", configure({ requestPrice = 0 }).error, "Bad-Parameter")
  eq("requestPrice bounded", configure({ requestPrice = 1000001 }).error, "Bad-Parameter")
  eq("no credit before the token is set", fund(F.game, 4000000).error, "Not-Token")
  eq("price in atoms", configure({ token = F.token, requestPrice = 4 }).requestPriceAtoms, 4000000)
  eq("token locked", configure({ token = F.other }).error, "Token-Locked")
  eq("price published", json.decode(base.fairinfo).requestPriceAtoms, 4000000)
  -- Attack (unfunded game): no balance, no session, and no registry entry.
  local r0 = open(F.p1, "unfunded")
  eq("an unfunded game is refused", r0.error, "Game-Unfunded")
  eq("Game-Unfunded names the price", r0.price, 4000000)
  eq("and takes no registry seat", Fair.state.gameCount, 0)
  -- Attack (forged Credit-Notice): only the configured token, attested.
  eq("wallet Credit-Notice refused", fund(F.game, 4000000, { body = wallet(F.stranger, {}) }).error, "Not-Token")
  eq("wallet-forged from-process refused", fund(F.game, 4000000,
    { body = wallet(F.stranger, { ["from-process"] = F.token }) }).error, "Not-Token")
  eq("another process refused", fund(F.game, 4000000, { from = F.other }).error, "Not-Token")
  eq("scheduler without from-process refused", fund(F.game, 4000000, { body = wallet(F.sched, {}) }).error, "Not-Token")
  eq("missing reference refused", fund(F.game, 4000000, { reference = "x1" }).error, "Missing-Reference")
  eq("forgeries credit nothing", accounts()[F.game], nil)
  -- Funding: X-Fair-Game, X-For, else Sender; each token reference once.
  r = fund(F.game, 1000000000, { reference = "t100" })
  eq("game funded", r.balance, 1000000000)
  eq("a replayed reference is a duplicate", fund(F.game, 1000000000, { reference = "t100" }).duplicate, true)
  eq("and credits nothing", accounts()[F.game].balance, 1000000000)
  eq("X-For funds too", fund(F.stranger, 100000000, { tag = "X-For" }).game, F.stranger)
  eq("Sender funds itself", fund(nil, 4000000, { sender = F.game2 }).game, F.game2)
  r, ob = fund(F.other, 3999999)
  check("below one request a new account is not opened: refunded", r.refunded == 3999999
    and ob["fair-refund"] and ob["fair-refund"].Recipient == F.payer and ob["fair-refund"].target == F.token)
  eq("refund carries the first transfer sequence", ob["fair-refund"] and ob["fair-refund"]["X-Transfer-Sequence"], "1")
  eq("a known game takes any amount", fund(F.game2, 1).balance, 4000001)
  eq("held = funded - paid out", held(), fundedIn - paidOut)
  -- Its own Transfers' Debit-Notices are accepted quietly; nobody else's.
  check("debit notice from the token", send(delivery(F.token, { Action = "Debit-Notice" })).ok == true)
  eq("debit notice from another process", send(delivery(F.other, { Action = "Debit-Notice" })).error, "Not-Token")
  -- A handler that fails rolls back: no sequence number taken, nothing half-applied.
  local seqBefore, origCredit = Fair.state.transferSeq, fair.credit
  fair.credit = function(st) st.transferSeq = st.transferSeq + 99; st.accounts[F.game].balance = 0; error("boom") end
  check("failing handler reports", tostring(fund(F.game, 4000000).error):match("boom") ~= nil)
  fair.credit = origCredit
  eq("rollback: sequence unchanged", Fair.state.transferSeq, seqBefore)
  eq("rollback: balance unchanged", Fair.state.accounts[F.game].balance, 1000000000)
  -- Configure: deployer only, bounded, beacon fixed once set.
  eq("configure deployer-only", configure({ beacon = F.beacon }, F.stranger).error, "Not authorised")
  eq("window below 10 s refused", configure({ fairWindowMs = 9999 }).error, "Bad-Parameter")
  eq("window above 10 min refused", configure({ fairWindowMs = 600001 }).error, "Bad-Parameter")
  r, ob = commit(F.p1, "early", F.c1)
  eq("no request before a beacon is set", count(ob), 0)
  -- Publishing only when the state moves.
  local rev = base.fairrev
  commit(F.p1, "unopened0", F.c1, true)
  eq("a refusal publishes nothing", base.fairrev, rev)
  send(wallet(F.stranger, { Action = "Get-Info" }))
  eq("a no-op Get-Info publishes nothing", base.fairrev, rev)
  check("configured", configure({ beacon = F.beacon, fairWindowMs = 60000, keep = 3, maxOpen = 8, minIntervalMs = 1000 }).ok == true)
  eq("min interval below 1 s refused", configure({ minIntervalMs = 999 }).error, "Bad-Parameter")
  eq("maxGames 0 refused", configure({ maxGames = 0 }).error, "Bad-Parameter")
  eq("maxPerGame above 4096 refused", configure({ maxPerGame = 4097 }).error, "Bad-Parameter")
  eq("beacon locked", configure({ beacon = F.other }).error, "Beacon-Locked")
  check("same beacon again fine", configure({ beacon = F.beacon }).ok == true)

  -- The target door.
  r = send(wallet(F.owner, { Action = "Fair.Configure", Data = encode({ keep = 3 }), target = string.rep("o", 43) }))
  eq("message for another process refused", r.error, "Refused: not signed for this process")

  -- The game authorizes sessions: no Fair.Open, no commit (and no beacon request).
  r, ob = commit(F.p1, "unopened", F.c1, true)
  eq("commit without Fair.Open refused", r.error, "Not-Opened")
  eq("refused commit sends nothing", count(ob), 0)
  open(F.p1, "stranger-opened", F.stranger)
  r = commit(F.p1, "stranger-opened", F.c1, true)
  eq("an allowance from another sender is not the game's", r.error, "Not-Opened")
  r = send(wallet(F.stranger, { Action = "Fair.Open", Session = "spoof", Player = F.p1, ["from-process"] = F.game }))
  check("wallet-forged from-process opens for the wallet, not the game",
    r.opened == true and r.game == F.stranger, r.game)
  eq("so the game's session stays closed", commit(F.p1, "spoof", F.c1, true).error, "Not-Opened")
  r = send({ target = SELF, Action = "Fair.Open", Session = "x", Player = F.p1 })
  eq("unsigned open refused", r.error, "Unsigned")
  r = open("short", "x")
  eq("open needs a player address", r.error, "Bad-Player")
  r = open(F.p2, "a|b")
  eq("open checks the session", r.error, "Bad-Session")
  r = open(F.p1, "dup")
  check("open", r.opened == true)
  check("open again is a duplicate", open(F.p1, "dup").duplicate == true)

  -- Commit validation.
  eq("bad commit", commit(F.p1, "x", "zz").error, "Bad-Commit")
  eq("bad session", commit(F.p1, "a|b", F.c1).error, "Bad-Session")
  eq("long session", commit(F.p1, string.rep("s", 65), F.c1).error, "Bad-Session")
  r = send({ target = SELF, Action = "Fair.Commit", Game = F.game, Session = "x", Commit = F.c1 })
  eq("unsigned commit refused", r.error, "Unsigned")
  local mixed = wallet(F.p1, { Action = "Fair.Commit", Game = F.game, Session = "x", Commit = F.c1 })
  mixed.commitments.d = { type = "rsa-pss-sha256", committer = F.p2, committed = { "target" } }
  eq("mixed signers refused", send(mixed).error, "Unsigned")

  -- The early commit (made before the beacon was set) goes out with the next message.
  r, ob = commit(F.p1, "sess-1", F.c1)
  check("commit accepted", r.committed == true)
  local req = ob["fair-request"]
  check("first commit sends the request", req ~= nil)
  eq("request goes to the beacon", req and req.target, F.beacon)
  eq("request action", req and req.Action, "Request-Random")
  eq("request id", req and req["Request-Id"], "fair-1")
  eq("no time on the request (the beacon uses its scheduler's)", req and req["Request-Time"], nil)
  eq("sess-1 in batch 1", sessionOf("sess-1").batch, 1)
  eq("early commit in batch 1", sessionOf("early").batch, 1)

  -- At most one outstanding request: later commits wait in batch 2.
  r, ob = commit(F.p2, "sess-2", F.c2)
  eq("no second request while one is out", count(ob), 0)
  r, ob = commit(F.p3, "sess-3", F.c3)
  eq("still none", count(ob), 0)
  eq("sess-2 waits in batch 2", sessionOf("sess-2").batch, 2)
  eq("outstanding is fair-1", batches().outstanding.requestId, "fair-1")
  eq("next batch is 2", batches().next, 2)

  -- Grinding: a committed session cannot change its commit; the same commit is a duplicate.
  eq("recommit refused", commit(F.p1, "sess-1", F.c2).error, "Session-Taken")
  eq("a committed session cannot be reopened", open(F.p1, "sess-1").error, "Session-Taken")
  r, ob = commit(F.p1, "sess-1", F.c1)
  check("commit replay is a duplicate", r.duplicate == true and count(ob) == 0)
  -- Front-running another player's session id does not block that player.
  r = commit(F.p2, "sess-1", F.c4)
  check("same session id, other key: separate session", r.committed == true)
  eq("front-runner bound with batch 2, not 1", sessionOf("sess-1", F.p2).batch, 2)

  -- Reveal before the value is bound: refused (and never needed).
  eq("reveal before bind refused", reveal(F.p1, "sess-1", F.s1).error, "Not-Bound")

  -- RNG-Result only from the beacon, only for the outstanding id.
  eq("result from another process refused", result("fair-1", F.round1, F.other).error, "Not-Beacon")
  r = send(wallet(F.stranger, { Action = "RNG-Result", ["from-process"] = F.beacon,
    Data = encode({ results = { { requestId = "fair-1", value = F.vb1 } } }) }))
  eq("wallet-forged from-process refused", r.error, "Not-Beacon")
  r = send(wallet(F.sched, { Action = "RNG-Result", Data = encode({ results = { { requestId = "fair-1", value = F.vb1 } } }) }))
  eq("scheduler-signed without from-process refused", r.error, "Not-Beacon")
  eq("result for another id ignored", result("fair-9", F.round1).error, "Stale-Result")
  eq("nothing bound yet", sessionOf("sess-1", F.p1).status, "committed")

  local reservedBefore = accounts()[F.game].reserved
  r, ob = result("fair-1", F.round1)
  eq("batch 1 bound", r.bound, 1)
  -- The games in the batch pay its request: two sessions, half each.
  eq("batch charged one request", r.charged, 4000000)
  local top = ob["fair-topup"]
  check("top-up to the beacon through the token", top and top.target == F.token and top.Recipient == F.beacon
    and top.Action == "Transfer" and top.Quantity == "4000000")
  eq("each session paid its share", sessionOf("sess-1", F.p1).charged, 2000000)
  eq("both reserves left the reserved pool", reservedBefore - accounts()[F.game].reserved, 8000000)
  eq("held = funded - paid out after a bind", held(), fundedIn - paidOut)
  local s1 = sessionOf("sess-1", F.p1)
  eq("beacon value is the per-request value", s1.beaconValue, F.vb1)
  eq("session value", s1.v, F.v1)
  eq("reveal-due", s1.status, "reveal-due")
  eq("revealBy = now + window", s1.revealBy, clock + 60000)
  -- The next batch is requested in the same slot.
  eq("batch 2 requested in the result's slot", ob["fair-request"] and ob["fair-request"]["Request-Id"], "fair-2")
  -- Commit after value known: v_b1 is public now, but a new commit binds to batch 3.
  r = commit(F.p3, "late", F.c4)
  eq("commit after a value is known joins a later batch", sessionOf("late").batch, 3)
  eq("batch 2 untouched by result 1", sessionOf("sess-2").status, "committed")
  -- Replay of the old result.
  eq("old result replay ignored", result("fair-1", F.round1).error, "Stale-Result")

  -- Reveal: wrong secret, right secret, replay.
  eq("wrong secret refused", reveal(F.p1, "sess-1", F.s2).error, "Bad-Secret")
  eq("malformed secret refused", reveal(F.p1, "sess-1", "abc").error, "Bad-Secret")
  r, ob = reveal(F.p1, "sess-1", F.s1)
  check("revealed", r.revealed == true)
  eq("final", r.session and r.session.final, F.final1)
  local note = ob["fair-result"]
  eq("Fair-Result to the game", note and note.target, F.game)
  eq("Fair-Result status", note and note.Status, "revealed")
  eq("Fair-Result final", note and note.Final, F.final1)
  eq("Fair-Result names the player", note and note.Player, F.p1)
  eq("Fair-Result data", note and json.decode(note.Data).commit, F.c1)
  local fh = json.decode(base.fairhistory).entries
  check("fairhistory maps the session to the slot that resolved it",
    fh[#fh][1] == "session:" .. F.game .. "|sess-1|" .. F.p1 and fh[#fh][2] == slotNo, encode(fh[#fh]))
  r, ob = reveal(F.p1, "sess-1", F.s1)
  check("reveal replay is a duplicate, no second result", r.duplicate == true and ob["fair-result"] == nil)
  eq("expire after reveal changes nothing", expire("sess-1", F.p1).duplicate, true)

  -- Batch 2: sess-3 revealed by a third party (Player tag), sess-2 forfeits.
  r, ob = result("fair-2", F.round2, nil, 1000)
  eq("batch 3 requested next", ob["fair-request"] and ob["fair-request"]["Request-Id"], "fair-3")
  eq("expire before revealBy refused", expire("sess-2", F.p2).error, "Not-Expired")
  r = reveal(F.stranger, "sess-3", F.s3, F.p3)
  eq("anyone may reveal with the secret", r.session and r.session.final, F.final3)
  r = expire("sess-2", F.p2, 60001)
  check("forfeit after revealBy", r.forfeit == true)
  eq("forfeit value", r.session and r.session.final, F.forfeit2)
  eq("reveal after forfeit is a duplicate (final unchanged)", reveal(F.p2, "sess-2", F.s2).session.final, F.forfeit2)
  -- Late reveal (option on the outcome) refused even before anyone expires.
  local s14 = sessionOf("sess-1", F.p2)
  eq("front-runner session bound with batch 2", s14.status, "reveal-due")
  eq("reveal after revealBy refused", reveal(F.p2, "sess-1", F.s4).error, "Reveal-Late")
  r, ob = expire("sess-1", F.p2)
  eq("then it forfeits", ob["fair-result"] and ob["fair-result"].Status, "forfeit")

  -- Operator collusion: a shorter window applies only to new commits.
  configure({ fairWindowMs = 10000 })
  r, ob = result("fair-3", F.round3)
  eq("window fixed at commit", sessionOf("late").windowMs, 60000)
  eq("revealBy uses the session's window", sessionOf("late").revealBy, clock + 60000)
  configure({ fairWindowMs = 60000 })
  -- Game + validators collude: they know v but not s; final differs per secret.
  check("final depends on the secret", fair.finalValue(F.v1, F.s1) ~= fair.finalValue(F.v1, F.s2))

  -- Bounded fairsessions: keep = 3 resolved per game; a pruned key cannot be replayed.
  local resolved = 0
  for _, s in ipairs(sessions()) do if s.status == "revealed" or s.status == "forfeit" then resolved = resolved + 1 end end
  eq("resolved kept per game", resolved, 3)
  check("oldest resolved pruned", sessionOf("sess-1", F.p1) == nil)
  eq("pruned key replay refused", commit(F.p1, "sess-1", F.c1).error, "Session-Done")
  -- RNG-Error: requeued into the open batch, no immediate resend, backoff, fresh id.
  r, ob = commit(F.p1, "e1", F.c1)
  local out = batches().outstanding
  check("e1 requested", out ~= nil and ob["fair-request"] ~= nil)
  local errId = out and out.requestId
  r, ob = commit(F.p2, "e2", F.c2)
  eq("stale error ignored", rngError("fair-999").error, "Stale-Result")
  r, ob = rngError(errId, "Round-Abandoned")
  eq("error requeues", r.requeued, 1)
  eq("no resend in the error's slot", count(ob), 0)
  eq("e1 moved into e2's batch", sessionOf("e1").batch, sessionOf("e2").batch)
  r, ob = send(wallet(F.stranger, { Action = "Get-Info" }))
  eq("no resend before the backoff", count(ob), 0)
  r, ob = send(wallet(F.stranger, { Action = "Get-Info" }), 5000)
  local retry = ob["fair-request"]
  check("resend after the backoff", retry ~= nil)
  check("retry uses a fresh id", retry and retry["Request-Id"] ~= errId and retry["Request-Id"]:match("%-1$") ~= nil, retry and retry["Request-Id"])
  r = result(retry["Request-Id"], F.round1)
  eq("retried batch bound", sessionOf("e1").status, "reveal-due")
  eq("both bound together", sessionOf("e2").status, "reveal-due")

  -- A request never answered is given up after 30 min (no second one before).
  send(wallet(F.stranger, { Action = "Get-Info" }), 1000) -- past the min interval
  commit(F.p3, "lost", F.c3)
  local lostId = batches().outstanding.requestId
  r, ob = send(wallet(F.stranger, { Action = "Get-Info" }), 1700000)
  eq("still waiting under 30 min", count(ob), 0)
  r, ob = send(wallet(F.stranger, { Action = "Get-Info" }), 200000)
  eq("lost request requeued (after backoff)", batches().outstanding, nil)
  r, ob = send(wallet(F.stranger, { Action = "Get-Info" }), 5000)
  check("lost batch re-requested", ob["fair-request"] ~= nil and ob["fair-request"]["Request-Id"] ~= lostId)

  -- maxOpen bounds unresolved sessions.
  configure({ maxOpen = 1 })
  eq("full", commit(F.p1, "full", F.c1).error, "Fair-Full")
  configure({ maxOpen = 8 })

  -- Restore: a fresh VM rebuilds from fairstate.
  local before = base.fairsessions
  local gamesBefore = Fair.state.gameCount
  local accountsBefore, seqBefore2 = base.fairaccounts, Fair.state.transferSeq
  Fair = { rev = 0, owner = "", state = fair.new() }
  send(wallet(F.stranger, { Action = "Get-Info" }))
  check("restored metered, token and price", Fair.state.metered == true and Fair.state.token == F.token
    and Fair.state.price == 4000000)
  eq("restored balances", base.fairaccounts, accountsBefore)
  eq("restored transfer sequence", Fair.state.transferSeq, seqBefore2)
  check("restored reference guard", fund(F.game, 1000000000, { reference = "t100" }).duplicate == true)
  check("restored integers", math.type(Fair.state.accounts[F.game].balance) == "integer")

  -- Withdraw: the game's free balance only, once per nonce, own sequence stream.
  local free = math.tointeger(accounts()[F.game].balance)
  eq("unsigned withdraw refused", send({ target = SELF, Action = "Fair.Withdraw", Nonce = "1" }).error, "Unsigned")
  eq("withdraw needs a nonce", send(delivery(F.game, { Action = "Fair.Withdraw" })).error, "Bad-Nonce")
  eq("more than the free balance refused", send(delivery(F.game, { Action = "Fair.Withdraw", Nonce = "1",
    Quantity = tostring(free + 1) })).error, "Insufficient-Balance")
  local seqNow = Fair.state.transferSeq
  r, ob = send(delivery(F.game, { Action = "Fair.Withdraw", Nonce = "1", Quantity = "1000" }))
  local w = ob["fair-withdraw"]
  check("withdrawal pays the game through the token", r.withdrawn == 1000 and w and w.target == F.token
    and w.Recipient == F.game and w.Quantity == "1000")
  eq("withdrawal takes the next sequence", w and w["X-Transfer-Sequence"], string.format("%d", seqNow + 1))
  r, ob = send(delivery(F.game, { Action = "Fair.Withdraw", Nonce = "1", Quantity = "1000" }))
  check("replayed withdraw pays nothing", r.error == "Bad-Nonce" and ob["fair-withdraw"] == nil)
  eq("an older nonce too", send(delivery(F.game, { Action = "Fair.Withdraw", Nonce = "0" })).error, "Bad-Nonce")
  eq("a stranger withdraws only its own", send(delivery(F.stranger, { Action = "Fair.Withdraw", Nonce = "1",
    Quantity = tostring(free) })).error, "Insufficient-Balance")
  r = send(delivery(F.game, { Action = "Fair.Withdraw", Nonce = "7" }))
  eq("withdraw all that is free", r.balance, 0)
  check("reserved stays", r.reserved > 0)
  eq("then an open is unfunded", open(F.p1, "after-withdraw").error, "Game-Unfunded")
  local strictly = true
  for i = 2, #seqs do if seqs[i] ~= seqs[i - 1] + 1 then strictly = false end end
  check("transfer sequences are 1, 2, 3, ... with no gap", strictly and seqs[1] == 1, table.concat(seqs, ","))
  eq("held = funded - paid out at the end", held(), fundedIn - paidOut)
  check("restored game registry", gamesBefore > 0 and Fair.state.gameCount == gamesBefore
    and Fair.state.games[F.game] ~= nil, Fair.state.gameCount)
  eq("restored beacon", Fair.state.beacon, F.beacon)
  eq("restored sessions", json.decode(base.fairsessions)[F.game][1].commit, json.decode(before)[F.game][1].commit)

  -- A replayed signed Fair.Open or Fair.Commit never reaches the process:
  -- the scheduler assigns a signed message once.
  local openMsg = delivery(F.game2, { Action = "Fair.Open", Session = "rp", Player = F.p1, id = "msg-open-rp" })
  local rOpen = send(openMsg)
  check("open rp", rOpen.opened == true, rOpen.error)
  eq("its replay is refused by the scheduler", send(openMsg).status, 409)
  local commitMsg = wallet(F.p1, { Action = "Fair.Commit", Game = F.game2, Session = "rp", Commit = F.c4, id = "msg-commit-rp" })
  local rCommit = send(commitMsg)
  check("commit rp", rCommit.committed == true, rCommit.error)
  eq("its replay is refused by the scheduler", send(commitMsg).status, 409)

  -- Embedded mode: a game keeps the state itself (and opens its own sessions).
  local st = fair.new({ beacon = F.beacon, windowMs = 30000 })
  local d, o = fair.dispatch(st, "Fair.Commit", { Game = F.game, Session = "sess-1", Commit = F.c1 },
    F.p1, false, 1000)
  eq("embedded: commit before open refused", o, "Not-Opened")
  fair.open(st, { game = F.game, session = "sess-1", player = F.p1, now = 1000 })
  d, o = fair.dispatch(st, "Fair.Commit", { Game = F.game, Session = "sess-1", Commit = F.c1 },
    F.p1, false, 1000)
  eq("embedded commit sends request", o["fair-request"]["Request-Id"], "fair-1")
  d = fair.dispatch(st, "RNG-Result", { Data = { results = { { requestId = "fair-1", value = F.vb1 } } } }, F.beacon, false, 2000)
  eq("embedded: unattested beacon result refused", select(2, fair.dispatch(st, "RNG-Result",
    { Data = { results = { { requestId = "fair-1", value = F.vb1 } } } }, F.beacon, false, 2000)), "Not-Beacon")
  d = fair.dispatch(st, "RNG-Result", { Data = { results = { { requestId = "fair-1", value = F.vb1 } } } }, F.beacon, true, 2000)
  eq("embedded bound", d.bound, 1)
  local x, y = fair.dispatch(st, "RNG-Result", { Data = {} }, F.beacon, true, 2000)
  check("embedded game's own results pass through", x == nil)
  d, o = fair.dispatch(st, "Fair.Reveal", { Game = F.game, Session = "sess-1", Secret = F.s1 }, F.p1, false, 3000)
  eq("embedded final", d.session.final, fair.finalValue(fair.sessionValue(F.vb1, F.game, "sess-1"), F.s1))
  x, y = fair.dispatch(st, "Other", {}, F.p1, false, 3000)
  check("embedded: other actions not fair's", x == nil and y == nil)

  -- Minimum interval between beacon requests (drain bound).
  st = fair.new({ beacon = F.beacon, minIntervalMs = 5000 })
  local function openCommit(name, c, player, now)
    fair.open(st, { game = F.game, session = name, player = player or F.p1, now = now })
    return fair.commit(st, { game = F.game, session = name, player = player or F.p1, commit = c,
      now = now })
  end
  d, o = openCommit("m1", F.c1, F.p1, 10000)
  eq("first request at once", o["fair-request"] and o["fair-request"]["Request-Id"], "fair-1")
  d, o = openCommit("m2", F.c2, F.p1, 10500)
  d, o = fair.onResult(st, { now = 11000, data = { results = { { requestId = "fair-1", value = F.vb1 } } } })
  eq("next batch waits for the interval", o["fair-request"], nil)
  eq("not at 4.999 s", fair.pump(st, 14999), nil)
  local m = fair.pump(st, 15000)
  eq("sent once the interval has passed", m and m["Request-Id"], "fair-2")

  -- Caps: sessions per game, games tracked, allowance expiry.
  st = fair.new({ beacon = F.beacon, maxPerGame = 2, maxGames = 2 })
  check("per-game 1", fair.open(st, { game = F.game, session = "c1", player = F.p1, now = 1000 }) ~= nil)
  check("per-game 2", fair.open(st, { game = F.game, session = "c2", player = F.p1, now = 1000 }) ~= nil)
  eq("per-game cap", select(2, fair.open(st, { game = F.game, session = "c3", player = F.p1, now = 1000 })), "Game-Full")
  check("second game", fair.open(st, { game = F.game2, session = "c1", player = F.p1, now = 1000 }) ~= nil)
  eq("game cap with no idle game", select(2, fair.open(st, { game = F.other, session = "c1", player = F.p1, now = 1000 })), "Fair-Full")
  eq("commit after the allowance lapsed refused", select(2, fair.commit(st, { game = F.game, session = "c1", player = F.p1,
    commit = F.c1, now = 1000 + 600001 })), "Not-Opened")
  check("lapsed allowances free the game's slots",
    fair.open(st, { game = F.game, session = "c3", player = F.p1, now = 1000 + 600001 }) ~= nil)
  -- Attack (registry lock): F.game2's allowance lapsed but F.game2 never
  -- opened again. The eviction scan drops lapsed allowances itself, so the
  -- throwaway game is idle and a new game evicts it.
  check("idle game evicted for a new one", fair.open(st, { game = F.other, session = "c1", player = F.p1, now = 1000 + 600002 }) ~= nil)
  eq("still two games", st.gameCount, 2)
  eq("the idle one went", st.games[F.game2], nil)
  st = fair.new({ beacon = F.beacon, maxGames = 3 })
  for i = 1, 3 do fair.open(st, { game = string.rep(tostring(i), 43), session = "s", player = F.p1, now = 1000 }) end
  eq("throwaway games fill the registry", select(2, fair.open(st, { game = F.game, session = "s", player = F.p1, now = 2000 })), "Fair-Full")
  check("their lapsed allowances free it", fair.open(st, { game = F.game, session = "s", player = F.p1, now = 1000 + 600001 }) ~= nil
    and st.gameCount == 3 and st.games[F.game] ~= nil)
  -- Metered library: rounding, drain attempts, expiry refund, eviction.
  local tref = 0
  local function credit(s, game, atoms)
    tref = tref + 1
    return fair.credit(s, { from = F.token, fromProcess = true, sender = F.payer, quantity = tostring(atoms),
      reference = "t" .. tref, forGame = game })
  end
  local function oc(s, game, name, now, noCommit)
    local d1, e1 = fair.open(s, { game = game, session = name, player = F.p1, now = now })
    if not d1 or noCommit then return d1, e1 end
    return fair.commit(s, { game = game, session = name, player = F.p1, commit = F.c1, now = now })
  end
  local function total(s)
    local n = 0
    for _, a in pairs(s.accounts) do
      check("library: never negative", a.balance >= 0 and a.reserved >= 0, a.balance)
      n = n + a.balance + a.reserved
    end
    return n
  end
  local A, B = string.rep("a", 43), string.rep("b", 43)
  st = fair.new({ metered = true, token = F.token, price = 10, unit = 4 })
  credit(st, A, 30); credit(st, B, 30)
  oc(st, A, "s1", 1000); oc(st, A, "s2", 1000); oc(st, B, "s1", 1000)
  eq("reserved at open", st.accounts[A].reserved, 20)
  st.beacon = F.beacon
  local q = fair.pump(st, 2000)
  eq("three sessions, one request", q and q["Request-Id"], "fair-1")
  d, o = fair.onResult(st, { now = 3000, data = { results = { { requestId = "fair-1", value = F.vb1 } } } })
  eq("price split exactly", d.charged, 10)
  -- Keys sort A|s1, A|s2, B|s1: 10 = 4 + 3 + 3, the remainder to the first.
  eq("first key pays the remainder atom", st.sessions[A .. "|s1|" .. F.p1].charged, 4)
  eq("A paid 7, rest of its reserve freed", st.accounts[A].balance, 23)
  eq("B paid 3", st.accounts[B].balance, 27)
  eq("nothing left reserved", st.accounts[A].reserved + st.accounts[B].reserved, 0)
  eq("top-up in whole units (unit 4)", o["fair-topup"] and o["fair-topup"].Quantity, "8")
  eq("the rest waits as surplus", st.surplus, 2)
  eq("library: held + sent + surplus = funded", total(st) + 8 + st.surplus, 60)
  -- A refused request charges nobody and keeps the reserve for the retry.
  oc(st, B, "s2", 4000)
  q = fair.pump(st, 9000)
  local before = st.accounts[B].balance
  fair.onError(st, { requestId = q["Request-Id"], error = "Round-Abandoned", now = 9100 })
  check("abandoned: no charge, reserve kept", st.accounts[B].balance == before and st.accounts[B].reserved == 10)
  -- Price raised while a session waits: its share is capped at its reserve.
  st.price = 40
  q = fair.pump(st, 20000)
  d = fair.onResult(st, { now = 20100, data = { results = { { requestId = q["Request-Id"], value = F.vb2 } } } })
  eq("share capped at the reserve", d.charged, 10)
  check("B never negative", st.accounts[B].balance >= 0 and st.accounts[B].reserved == 0)
  -- Attack (drain): a game with one request's worth opens one session, no more.
  st = fair.new({ metered = true, token = F.token, price = 10, unit = 1, beacon = F.beacon })
  credit(st, A, 10)
  check("one funded session", oc(st, A, "d1", 1000, true) ~= nil)
  eq("the second is unfunded", select(2, oc(st, A, "d2", 1000, true)), "Game-Unfunded")
  eq("reserved is not withdrawable", select(2, fair.withdraw(st, { game = A, nonce = "1", now = 1000 })), "Insufficient-Balance")
  eq("another game's balance is not yours", select(2, oc(st, B, "d1", 1000, true)), "Game-Unfunded")
  eq("a commit for an unfunded game is not opened", select(2, fair.commit(st, { game = B, session = "d1", player = F.p1,
    commit = F.c1, now = 1000 })), "Not-Opened")
  eq("dust credit for a new game refunded", credit(st, B, 9).refunded, 9)
  -- Refund on expiry: an allowance that lapses unused gives its reserve back.
  d = fair.withdraw(st, { game = A, nonce = "1", now = 1000 + 600001 })
  eq("lapsed reserve back and withdrawable", d and d.withdrawn, 10)
  eq("withdraw replay pays nothing", select(2, fair.withdraw(st, { game = A, nonce = "1", now = 1000 + 600002 })), "Bad-Nonce")
  -- Eviction keeps the balance: the registry forgets A, its account stays.
  st = fair.new({ metered = true, token = F.token, price = 10, unit = 1, beacon = F.beacon, maxGames = 1 })
  credit(st, A, 25); credit(st, B, 10)
  oc(st, A, "e1", 1000, true)
  check("B evicts the idle A after its allowance lapsed", oc(st, B, "e1", 1000 + 600001, true) ~= nil and st.games[A] == nil)
  eq("A's balance survives eviction (reserve released)", st.accounts[A].balance, 25)
  check("and A opens again with it", oc(st, A, "e2", 1000 + 600001 * 2, true) ~= nil)
  -- Embedded (unmetered) mode needs no token or balance.
  st = fair.new({ beacon = F.beacon })
  check("embedded: no funding needed", fair.open(st, { game = F.game, session = "s", player = F.p1, now = 1000 }) ~= nil)

  -- State bounds after M >> N sessions (docs/PERMISSIONLESS.md): resolved
  -- sessions (keep), forgotten keys (GUARD_MS of scheduler time), the slot index (1024 entries).
  st = fair.new({ beacon = F.beacon })
  local G, P, t, slotN = F.game, F.p1, 1000, 0
  local maxSessions, maxDone, firstAt, firstSlot = 0, 0, nil, nil
  for i = 1, 700 do
    local sess, secret = "h" .. i, rng.hex(rng.sha256("secret|" .. i))
    fair.open(st, { game = G, session = sess, player = P, now = t })
    fair.commit(st, { game = G, session = sess, player = P, commit = fair.commitHash(G, sess, secret),
      now = t })
    firstAt = firstAt or t
    local out = st.outstanding
    slotN = slotN + 1
    fair.onResult(st, { now = t + 1, slot = slotN, data = { results = { { requestId = out and out.requestId,
      round = i, value = rng.hex(rng.sha256("round|" .. i)) } } } })
    slotN = slotN + 1
    local d = fair.reveal(st, { game = G, session = sess, player = P, secret = secret, now = t + 2, slot = slotN })
    if i == 1 then firstSlot = d and slotN end
    maxSessions, maxDone = math.max(maxSessions, count(st.sessions)), math.max(maxDone, count(st.done))
    t = t + 6000
  end
  check("resolved sessions stay within keep", maxSessions <= st.keep + 1, maxSessions)
  check("forgotten keys stay within GUARD_MS of scheduler time", maxDone <= 110, maxDone)
  check("the slot index stays within 1024", #st.history == 1024, #st.history)
  local last = st.history[#st.history]
  check("the index maps the newest session to its slot", last[1] == "session:" .. G .. "|h700|" .. P and last[2] == slotN)
  check("the first session was indexed at its slot", firstSlot == 2)
  eq("a long-forgotten session takes no commit without a new Open", select(2, fair.commit(st, { game = G, session = "h1", player = P,
    commit = fair.commitHash(G, "h1", rng.hex(rng.sha256("x"))), now = t })), "Not-Opened")
  -- Token references: the newest 1024, older ones below the floor.
  st = fair.new({ metered = true, token = F.token, price = 1, unit = 1, beacon = F.beacon })
  for i = 1, 1100 do fair.credit(st, { from = F.token, fromProcess = true, sender = F.payer, quantity = "5",
    reference = "t" .. i, forGame = G }) end
  check("credited stays within CREDIT_KEEP", count(st.credited) <= 1024 and st.creditFloor > 0, count(st.credited))
  local balBefore = st.accounts[G].balance
  local again = fair.credit(st, { from = F.token, fromProcess = true, sender = F.payer, quantity = "5", reference = "t1", forGame = G })
  check("a pruned reference is still a duplicate", again and again.duplicate == true and st.accounts[G].balance == balBefore)

  -- Owners (vendor/gov.lua): the launch wallet bootstraps and renounces;
  -- the DAO's money actions (requestPrice, the DAO seat, code) wait for
  -- Effective-At >= receipt + 24 h. Raw reply text asserted.
  local function out() return base.results.output.data end
  local function finfo() return json.decode(base.fairinfo) end
  local FLOOR = 86400000
  local function at(extra) return string.format("%d", clock + 100 + FLOOR + (extra or 0)) end
  local function apply(id) return send(wallet(F.stranger, { Action = "Gov.Apply", ["Gov-Id"] = tostring(id) })) end
  local function due(id) Fair.gov.pending[tostring(id)].effectiveAt = clock end
  send(delivery(F.dao, { Action = "Fair.Configure", Keep = "4" }))
  eq("no DAO yet: a DAO delivery is nobody", out(), '{"error":"Not authorised"}')
  send(wallet(F.stranger, { Action = "Gov.Set-Dao", Dao = F.dao }))
  eq("a stranger cannot set the DAO", out(), '{"error":"Not authorised","ok":false}')
  send(wallet(F.stranger, { Action = "Gov.Set-Dao", Dao = F.stranger, ["from-process"] = F.dao }))
  eq("a wallet forging the DAO's from-process is nobody", out(), '{"error":"Not authorised","ok":false}')
  send(delivery(F.game, { Action = "Gov.Set-Dao", Dao = F.game }))
  eq("another process is nobody", out(), '{"error":"Not authorised","ok":false}')
  send(wallet(F.owner, { Action = "Gov.Renounce-Wallet" }))
  eq("the wallet cannot renounce before a DAO is set", out(), '{"error":"Set a DAO first","ok":false}')
  local revGov = base.fairrev
  send(wallet(F.owner, { Action = "Gov.Set-Dao", Dao = F.dao }))
  eq("the wallet sets the DAO", out(), '{"dao":"' .. F.dao .. '","ok":true}')
  check("an owner change is published at once", base.fairrev ~= revGov
    and json.decode(base.fairstate).owners.dao == F.dao, base.fairrev)
  check("fairinfo publishes the owners", base.fairinfo:find('"gov":{"approved":"","approvedAt":0,"code":"","dao":"' .. F.dao
    .. '","version":0,"wallet":true}', 1, true) ~= nil, base.fairinfo:match('"gov":%b{}'))
  send(wallet(F.owner, { Action = "gov.set_dao", dao = F.dao }))
  eq("verb and tag names fold case, - and _", out(), '{"dao":"' .. F.dao .. '","ok":true}')

  -- Fair.Configure: either owner, by tag, at once; Data from the wallet only.
  r = send(delivery(F.dao, { Action = "Fair.Configure", Keep = "4", ["Max-Open"] = "9" }))
  check("the DAO configures by tag", r.ok == true and r.keep == 4 and r.maxOpen == 9, out())
  check("tag numbers are stored as integers", out():find('"keep":4,', 1, true) ~= nil
    and math.type(Fair.state.keep) == "integer", out())
  send(delivery(F.dao, { Action = "Fair.Configure", Data = encode({ keep = 5 }) }))
  eq("the DAO's Data is not read", Fair.state.keep, 4)
  send(delivery(F.dao, { Action = "fair.configure", max_open = "8" }))
  eq("the DAO's tags fold too", Fair.state.maxOpen, 8)
  eq("a tag spelled twice with two values is refused",
    send(wallet(F.owner, { Action = "Fair.Configure", Keep = "5", keep = "6" })).error, "Bad-Parameter")
  eq("a fraction is refused", send(delivery(F.dao, { Action = "Fair.Configure", Keep = "4.5" })).error, "Bad-Parameter")
  eq("bounds hold for the DAO", send(delivery(F.dao, { Action = "Fair.Configure", ["Fair-Window-Ms"] = "9999" })).error,
    "Bad-Parameter")
  eq("the beacon stays locked for the DAO", send(delivery(F.dao, { Action = "Fair.Configure", Beacon = F.other })).error,
    "Beacon-Locked")
  eq("bad Data from the wallet", send(wallet(F.owner, { Action = "Fair.Configure", Data = "{" })).error, "Bad-Config")
  check("the wallet still configures beside the DAO", configure({ keep = 3 }).ok == true and Fair.state.keep == 3)
  eq("a stranger cannot configure", send(wallet(F.stranger, { Action = "Fair.Configure", Keep = "4" })).error, "Not authorised")
  eq("the DAO's address as a wallet is nobody", send(wallet(F.dao, { Action = "Fair.Configure", Keep = "4" })).error,
    "Not authorised")
  -- Every Gov.* and Fair.Configure needs the scheduler's time, never going back.
  base = compute(base, { body = delivery(F.dao, { Action = "Fair.Configure", Keep = "4" }), process = SELF, slot = 900000 })
  eq("Fair.Configure with no time is refused", json.decode(base.results.output.data).error, "No-Time")
  base = compute(base, { body = delivery(F.dao, { Action = "Fair.Configure", Keep = "4" }), timestamp = clock - 1,
    process = SELF, slot = 900001 })
  check("one older than the last is refused, nothing changed", json.decode(base.results.output.data).error == "Time-Went-Back"
    and Fair.state.keep == 3)
  -- requestPrice is money: it waits the floor.
  local price0 = Fair.state.price
  r = send(delivery(F.dao, { Action = "Fair.Configure", ["Request-Price"] = "5" }))
  check("a requestPrice change without Effective-At is refused", r.error == "Effective-At-Required" and Fair.state.price == price0, out())
  eq("short of the floor", send(delivery(F.dao, { Action = "Fair.Configure", ["Request-Price"] = "5",
    ["Effective-At"] = at(-1) })).error, "Effective-At-Too-Soon")
  eq("bounds checked on proposal", send(delivery(F.dao, { Action = "Fair.Configure", ["Request-Price"] = "0",
    ["Effective-At"] = at() })).error, "Bad-Parameter")
  r = send(delivery(F.dao, { Action = "Fair.Configure", ["Request-Price"] = "5", ["Effective-At"] = at() }))
  local pid1 = r.pending and r.pending.id
  check("pending and published", pid1 and Fair.state.price == price0 and finfo().govPending[1].id == pid1
    and finfo().hatch == true and json.decode(base.fairstate).gov.pending[tostring(pid1)] ~= nil, out())
  eq("apply before due refused", apply(pid1).error, "Too-Early")
  local gw = Fair.state.accounts[F.game] and Fair.state.accounts[F.game].balance or 0
  if gw > 0 then
    r = send(delivery(F.game, { Action = "Fair.Withdraw", Nonce = "900", Quantity = "1" }))
    check("a game withdraws its free balance while it waits", r.withdrawn == 1, out())
  end
  due(pid1)
  r = apply(pid1)
  check("anyone applies it once due; the hatch closes", r.applied == pid1 and Fair.state.price == 5 * Fair.state.unit
    and finfo().hatch == false and #finfo().govPending == 0, out())
  check("the same price again is harmless", send(delivery(F.dao, { Action = "Fair.Configure", ["Request-Price"] = "5" })).ok == true)
  r = send(delivery(F.dao, { Action = "Fair.Configure", ["Request-Price"] = "6", ["Effective-At"] = at() }))
  eq("the DAO cancels", send(delivery(F.dao, { Action = "Gov.Cancel", ["Gov-Id"] = tostring(r.pending.id) })).cancelled, r.pending.id)
  eq("a stranger cannot cancel", send(wallet(F.stranger, { Action = "Gov.Cancel", ["Gov-Id"] = "1" })).error, "Not authorised")
  r = send(delivery(F.dao, { Action = "Fair.Configure", ["Request-Price"] = "6", ["Effective-At"] = at() }))
  Fair.gov.pending[tostring(r.pending.id)].effectiveAt = clock - 14 * 86400000 - 1
  send(wallet(F.stranger, { Action = "Get-Info" }))
  check("a lapsed entry is dropped", #finfo().govPending == 0 and apply(r.pending.id).error == "Unknown-Gov-Id")
  eq("the DAO's Set-Dao waits", send(delivery(F.dao, { Action = "Gov.Set-Dao", Dao = F.other })).error, "Effective-At-Required")

  -- Code: approved by an owner, uploaded by anyone; the state carries over.
  local code = "local prev = compute\nFairUpgrade = 1\nfunction compute(b, r) return prev(b, r) end"
  send(wallet(F.stranger, { Action = "Gov.Upgrade", Data = code }))
  eq("unapproved code is refused", out(), '{"error":"No approved code","ok":false}')
  send(delivery(F.dao, { Action = "Gov.Approve-Code", ["Code-Root"] = Gov.rootOf(code) }))
  eq("the DAO's approval needs Effective-At", out(), '{"error":"Effective-At-Required","ok":false}')
  local codeAt = at()
  send(delivery(F.dao, { Action = "Gov.Approve-Code", ["Code-Root"] = Gov.rootOf(code), ["Effective-At"] = codeAt }))
  eq("the DAO approves a root", out(), '{"approved":"' .. Gov.rootOf(code) .. '","effectiveAt":' .. codeAt .. ',"ok":true}')
  send(wallet(F.stranger, { Action = "Gov.Upgrade", Data = code }))
  eq("not before its Effective-At", out(), '{"effectiveAt":' .. codeAt .. ',"error":"Not-Yet-Effective","ok":false}')
  GovState.approvedAt = clock -- white box: now due
  send(wallet(F.stranger, { Action = "Gov.Upgrade", Data = code }))
  eq("anyone uploads the approved code", out(), '{"installed":"' .. Gov.rootOf(code) .. '","ok":true,"version":1}')
  check("the new code runs on the same state", FairUpgrade == 1 and Fair.state.keep == 3 and finfo().gov.version == 1)

  -- Renounce: one way, the wallet's alone.
  send(delivery(F.dao, { Action = "Gov.Renounce-Wallet" }))
  eq("the DAO cannot renounce the wallet", out(), '{"error":"Not authorised","ok":false}')
  send(wallet(F.owner, { Action = "Gov.Renounce-Wallet" }))
  eq("the wallet renounces", out(), '{"ok":true,"wallet":false}')
  eq("the wallet is out", configure({ keep = 4 }).error, "Not authorised")
  check("the DAO still configures", send(delivery(F.dao, { Action = "Fair.Configure", Keep = "4" })).ok == true)
  eq("the renounced wallet cannot cancel", send(wallet(F.owner, { Action = "Gov.Cancel", ["Gov-Id"] = "code" })).error, "Not authorised")
  r = send(delivery(F.dao, { Action = "Gov.Set-Dao", Dao = F.other, ["Effective-At"] = at() }))
  due(r.pending.id)
  r = apply(r.pending.id)
  check("the DAO's Set-Dao applies once due", r.dao == F.other and finfo().gov.dao == F.other, out())
  r = send(delivery(F.other, { Action = "Gov.Set-Dao", Dao = F.dao, ["Effective-At"] = at() }))
  due(r.pending.id)
  apply(r.pending.id)
  eq("and back", finfo().gov.dao, F.dao)

  -- A cold VM: the owners come back from fairstate; never a renounced wallet.
  Fair = { rev = 0, owner = "", state = fair.new() }
  send(wallet(F.stranger, { Action = "Get-Info" }))
  check("a rebuilt VM keeps the renounced wallet and the DAO", finfo().gov.wallet == false and finfo().gov.dao == F.dao
    and Fair.state.keep == 4, base.fairinfo:match('"gov":%b{}'))
  check("installed code comes back approved", finfo().gov.code == "" and finfo().gov.approved == Gov.rootOf(code))
  eq("the wallet stays out after a rebuild", configure({ keep = 5 }).error, "Not authorised")
  local fs = json.decode(base.fairstate)
  fs.owners = nil
  base.fairstate, base.fairrev = encode(fs), string.format("%d", Fair.rev + 1)
  Fair = { rev = 0, owner = "", state = fair.new() }
  send(wallet(F.owner, { Action = "Gov.Set-Dao", Dao = F.owner }))
  eq("a published state with no owners re-arms nobody", out(), '{"error":"Not authorised","ok":false}')

  lines[#lines + 1] = passed .. " passed, " .. failed .. " failed"
  return table.concat(lines, "\n")
end

function fairtest()
  local ok, out = pcall(runFairTests)
  if ok then return out end
  return "ERROR " .. tostring(out) .. "\n" .. table.concat(lines, "\n")
end
