-- token_test.lua: genesis, seal, sequenced-v1 and accounting checks for RNG.

local passed, failed, lines = 0, 0, {}
local function check(name, ok, detail)
  if ok then passed = passed + 1 else
    failed = failed + 1
    lines[#lines + 1] = "FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")
  end
end
local function eq(name, got, want)
  check(name, got == want, "got " .. tostring(got) .. ", want " .. tostring(want))
end

local SUPPLY = 1000000000000000

local function freshBase()
  return {
    ["scheduler-location"] = F.sched,
    process = { commitments = { p = { type = "rsa-pss-sha512", committer = F.owner } } },
  }
end
local base = freshBase()

local function goodAllocations()
  return { [F.owner] = SUPPLY - 2000000, [F.user] = 1000000, [F.process] = 1000000 }
end

-- A brand-new process: every token global back to its initial value.
local function reset(alloc, keepBase)
  Balances, TotalSupply, Minted, Sealed = {}, 0, 0, false
  TransferSeq, TokenAccountCount, TokenRevision, TokenCheckpointRevision = 0, 0, 0, 0
  TransferStreams, TransferStreamRevision = {}, 0
  TransferReceipts, TransferReceiptOrder = {}, {}
  GenesisAllocations = alloc
  if not keepBase then base = freshBase() end
end

local SELF = string.rep("t", 43)

local function wallet(signer, fields)
  local body = { target = SELF,
    commitments = { c = { type = "rsa-pss-sha512", committer = signer, committed = { "target", "action" } } } }
  for k, v in pairs(fields) do body[k] = v end
  return body
end

--- A push our scheduler ADMITTED (admission.lua): the body carries from-*
--- stamps and the Assignment (req) carries the matching admit-* keys. The
--- relaying signer is irrelevant: `signer` defaults to our scheduler, and a
--- trusted foreign scheduler (paralith's, for the vault) is admitted alike.
local Admits = setmetatable({}, { __mode = "k" })
local admitSlot = 0
local function delivery(fromProcess, fields, signer)
  local body = wallet(signer or F.sched, fields)
  admitSlot = admitSlot + 1
  local entry = "entry-" .. admitSlot
  body["from-process"], body["from-entry"], body["from-slot"] = fromProcess, entry, tostring(admitSlot)
  Admits[body] = { process = fromProcess, entry = entry, slot = admitSlot }
  return body
end

local function send(body, admit)
  local req = { body = body, process = SELF }
  local a = admit
  if a == nil then a = Admits[body] end
  if a then
    req["admit-process"], req["admit-entry"], req["admit-slot"] = a.process, a.entry, a.slot
  end
  base = compute(base, req)
  local out = base.results and base.results.output and base.results.output.data
  local ok, decoded = pcall(json.decode, out or "")
  return ok and decoded or {}, base.results and base.results.outbox or {}
end

local function pay(sequence, fields, signer)
  local body = { Action = "Transfer", Recipient = F.recipient, Quantity = "1",
                 ["X-Transfer-Sequence"] = sequence }
  for k, v in pairs(fields or {}) do body[k] = v end
  return send(delivery(F.process, body, signer))
end

local function boot()
  reset(goodAllocations())
  send(wallet(F.stranger, { Action = "Info" }))
end

local function count(t) local n = 0; for _ in pairs(t or {}) do n = n + 1 end; return n end

local function genesisTests()
  -- Refused genesis: every action fails and nothing is minted or published.
  local bad = {
    { "sum one atom short", { [F.owner] = SUPPLY - 1 } },
    { "sum one atom over", { [F.owner] = SUPPLY, [F.user] = 1 } },
    { "missing allocations", nil },
    { "empty allocations", {} },
    { "invalid address", { ["short"] = SUPPLY } },
    { "zero allocation", { [F.owner] = SUPPLY, [F.user] = 0 } },
    { "negative allocation", { [F.owner] = SUPPLY + 5, [F.user] = -5 } },
    { "fractional allocation", { [F.owner] = "999999999999999.5", [F.user] = "0.5" } },
    { "overflowing allocation", { [F.owner] = "9007199254740993", [F.user] = "1" } },
  }
  for _, case in ipairs(bad) do
    reset(case[2])
    local r = send(wallet(F.user, { Action = "Info" }))
    check("bad genesis (" .. case[1] .. ") refuses Info", r.error ~= nil, r.error)
    r = send(wallet(F.owner, { Action = "Transfer", Recipient = F.user, Quantity = "1" }))
    check("bad genesis (" .. case[1] .. ") refuses Transfer", r.error ~= nil)
    check("bad genesis (" .. case[1] .. ") mints nothing",
      TotalSupply == 0 and Minted == 0 and next(Balances) == nil and not Sealed)
    check("bad genesis (" .. case[1] .. ") publishes no supply",
      base.totalsupply == nil and base.tokeninfo == nil and base.balances == nil)
  end

  -- Good genesis.
  reset(goodAllocations())
  local r = send(wallet(F.stranger, { Action = "Info" }))
  eq("genesis Info answers", r.Ticker, "RNG")
  eq("genesis mints the fixed supply", TotalSupply, SUPPLY)
  eq("genesis Minted equals supply", Minted, SUPPLY)
  check("genesis seals", Sealed == true)
  eq("genesis credits allocation", Balances[F.user], 1000000)
  eq("genesis credits owner allocation", Balances[F.owner], SUPPLY - 2000000)
  eq("genesis publishes totalsupply", base.totalsupply, "1000000000000000")
  eq("genesis publishes holder balance key", base["balance-" .. F.process], "1000000")
  local info = json.decode(base.tokeninfo)
  eq("tokeninfo Sealed", info.Sealed, "true")
  eq("tokeninfo Supply", info.Supply, "1000000000000000")
  eq("tokeninfo publishes sequenced-v1", info.ProcessTransferProtocol, "sequenced-v1")
  eq("tokeninfo publishes sequence tag", info.ProcessTransferSequenceTag, "X-Transfer-Sequence")
  eq("tokeninfo publishes window", info.ProcessTransferWindow, "256")
  check("tokeninfo has no faucet fields", info.FaucetAmount == nil and info.FaucetLifetimeCap == nil)
  check("tokeninfo matches deploy-dao.mjs check",
    base.tokeninfo:find('"ProcessTransferProtocol"%s*:%s*"sequenced%-v1"') ~= nil)
  check("transferstreams published at genesis",
    base.transferstreams ~= nil and base.transferstreamrevision == "0")
  check("no faucet keys published", base.faucetcalls == nil and base.faucetallowance == nil)

  -- Mint once only: the prelude re-running cannot mint again.
  GenesisAllocations = goodAllocations()
  send(wallet(F.stranger, { Action = "Info" }))
  eq("second slot does not re-mint", TotalSupply, SUPPLY)
  eq("second slot keeps allocation", Balances[F.user], 1000000)

  -- Cold VM (globals lost, published map kept) restores and seals, never re-mints.
  reset(goodAllocations(), true)
  r = send(wallet(F.stranger, { Action = "Total-Supply" }))
  eq("cold VM restores supply", r.TotalSupply, "1000000000000000")
  eq("cold VM does not double the allocation", Balances[F.user], 1000000)
  check("cold VM is sealed", Sealed == true)
  eq("cold VM Minted from tokeninfo", Minted, SUPPLY)

  -- Published Sealed alone blocks a mint even with no balances key.
  reset(goodAllocations())
  base.tokeninfo = encode({ Sealed = "true" })
  base.transferstreams = encode({ revision = 0, senders = jsonObject({}) })
  base.transferstreamrevision = "0"
  send(wallet(F.stranger, { Action = "Info" }))
  check("published Sealed blocks genesis", TotalSupply == 0 and next(Balances) == nil and Sealed)
end

local function sealTests()
  reset(goodAllocations())
  send(wallet(F.stranger, { Action = "Info" }))
  for _, action in ipairs({ "Faucet", "Admin.Mint", "Mint", "admin.mint", "faucet" }) do
    for _, signer in ipairs({ F.owner, F.user }) do
      local r = send(wallet(signer, { Action = action, Recipient = F.user, Quantity = "25" }))
      check(action .. " is unknown (" .. (signer == F.owner and "owner" or "user") .. ")",
        type(r.error) == "string" and r.error:find("unknown action") ~= nil, r.error)
    end
  end
  eq("mint after seal changes nothing", TotalSupply, SUPPLY)
  eq("faucet gone: user balance unchanged", Balances[F.user], 1000000)

  local r = send(wallet(F.stranger, { Action = "Admin.Checkpoint" }))
  eq("checkpoint is deployer only", r.error, "Not authorised")
  r = send(wallet(F.owner, { Action = "Admin.Checkpoint" }))
  eq("deployer checkpoint allowed", r.checkpoint, true)
  eq("checkpoint moves nothing", TotalSupply, SUPPLY)
end

local function walletTests()
  reset(goodAllocations())
  local r, outbox = send(wallet(F.user, {
    Action = "Transfer", Recipient = F.recipient, Quantity = "10", ["X-For"] = F.stranger,
  }))
  eq("wallet transfer needs no sequence", r.Action, "Transfer-Success")
  eq("wallet debited", Balances[F.user], 999990)
  eq("recipient credited", Balances[F.recipient], 10)
  -- Reads, asserted on the raw reply: amounts are integer text.
  send(wallet(F.stranger, { Action = "Balance", Account = F.recipient }))
  local rawOut = base.results.output.data
  check("Balance of an account answers integer text", rawOut:find('"Balance":"10"', 1, true) ~= nil, rawOut)
  send(wallet(F.user, { Action = "Balance" }))
  rawOut = base.results.output.data
  check("Balance defaults to the signer", rawOut:find('"Balance":"999990"', 1, true) ~= nil
    and rawOut:find('"Account":"' .. F.user .. '"', 1, true) ~= nil, rawOut)
  send(wallet(F.stranger, { Action = "Balances" }))
  rawOut = base.results.output.data
  check("Balances lists holders as integer text", rawOut:find('"' .. F.recipient .. '":"10"', 1, true) ~= nil
    and not rawOut:find('%d%.%d'), rawOut)
  local notice = outbox["credit-notice"]
  check("credit notice shape", notice and notice.Action == "Credit-Notice" and notice.Sender == F.user
    and notice.Quantity == "10" and notice.target == F.recipient)
  eq("credit notice Reference t<n>", notice and notice.Reference, "t1")
  eq("credit notice forwards X- tags", notice and notice["X-For"], F.stranger)
  eq("debit notice Reference", outbox["debit-notice"] and outbox["debit-notice"].Reference, "t1")

  r = send(wallet(F.stranger, {
    Action = "Transfer", Recipient = F.recipient, Quantity = "1", ["from-process"] = F.user,
  }))
  eq("wallet cannot forge a process payer", r.error, "Unsigned messages cannot transfer")
  eq("forged transfer leaves user balance", Balances[F.user], 999990)

  r = send({ Action = "Transfer", Recipient = F.recipient, Quantity = "1", ["from-process"] = F.user })
  eq("unsigned transfer refused", r.error, "Unsigned messages cannot transfer")

  local mixed = wallet(F.user, { Action = "Transfer", Recipient = F.recipient, Quantity = "1" })
  mixed.commitments.other = { type = "rsa-pss-sha512", committer = F.stranger, committed = { "target" } }
  r = send(mixed)
  eq("mixed signers refused", r.error, "Unsigned messages cannot transfer")

  local hmac = { commitments = { c = { type = "hmac-sha256", committer = F.user } },
    Action = "Transfer", Recipient = F.recipient, Quantity = "1" }
  r = send(hmac)
  eq("hmac is not a signature", r.error, "Refused: not signed")

  -- A body-supplied Tags table cannot forge identity (envelope fields come
  -- from the body the node verified; tags never replace a body key).
  local victimBefore = Balances[F.user]
  r = send(wallet(F.stranger, { Tags = { Action = "Transfer", Recipient = F.stranger, Quantity = "5",
    commitments = { v = { type = "rsa-pss-sha512", committer = F.user, committed = { "target" } } } } }))
  eq("Tags-forged committer moves nothing", Balances[F.user], victimBefore)
  check("Tags-forged committer is the real signer", r.error == "Insufficient balance" or r.error == "Cannot transfer to yourself", r.error)
  r = send({ target = SELF, Tags = { Action = "Transfer", Recipient = F.stranger, Quantity = "5",
    commitments = { v = { type = "rsa-pss-sha512", committer = F.user, committed = { "target" } } } } })
  eq("Tags-forged committer on an unsigned body moves nothing", Balances[F.user], victimBefore)
  eq("Tags-forged committer on an unsigned body is unsigned", r.error, "Unsigned messages cannot transfer")
  local beaconish = F.process
  local processBefore = Balances[beaconish]
  r = send(wallet(F.stranger, { Tags = { Action = "Transfer", Recipient = F.stranger, Quantity = "5",
    ["X-Transfer-Sequence"] = "1", ["from-process"] = beaconish,
    commitments = { s = { type = "rsa-pss-sha512", committer = F.sched, committed = { "target" } } } } }))
  eq("Tags-forged scheduler + from-process moves nothing", Balances[beaconish], processBefore)
  r = send(wallet(F.stranger, { Action = "Transfer", Recipient = F.recipient, Quantity = "1",
    Tags = { FromProcess = beaconish, ["From-Process"] = beaconish } }))
  eq("Tags FromProcess is not a process payer", Balances[beaconish], processBefore)
  r = send(wallet(F.user, { Action = "Transfer", Recipient = F.recipient, Quantity = "1",
    Tags = { Quantity = "999", Recipient = F.stranger } }))
  eq("Tags cannot override a body tag", Balances[F.recipient], 11)
  send(wallet(F.recipient, { Action = "Transfer", Recipient = F.user, Quantity = "1" }))
  -- The node delivers body keys lowercase: a Tags key in another case must not
  -- shadow one (a "Quantity" tag beside the signed "quantity").
  local strangerBefore = Balances[F.stranger] or 0
  r = send(wallet(F.user, { action = "Transfer", recipient = F.recipient, quantity = "1",
    Tags = { Quantity = "999", Recipient = F.stranger } }))
  check("Tags never shadow a lowercase body field", Balances[F.recipient] == 11
    and (Balances[F.stranger] or 0) == strangerBefore, r.error)
  send(wallet(F.recipient, { Action = "Transfer", Recipient = F.user, Quantity = "1" }))

  -- The target door: a Transfer signed for another token is not replayed here.
  local otherToken = string.rep("o", 43)
  local before = Balances[F.user]
  r = send(wallet(F.user, { Action = "Transfer", Recipient = F.recipient, Quantity = "1", target = otherToken }))
  eq("transfer signed for another token refused", r.error, "Refused: not signed for this process")
  eq("refused transfer moves nothing", Balances[F.user], before)
  local unbound = wallet(F.user, { Action = "Transfer", Recipient = F.recipient, Quantity = "1" })
  unbound.commitments.c.committed = { "action", "quantity" }
  r = send(unbound)
  eq("signature not committing target refused", r.error, "Refused: the signature does not commit target")
  eq("unbound transfer moves nothing", Balances[F.user], before)
  r = compute(base, { body = wallet(F.user, { Action = "Transfer", Recipient = F.recipient, Quantity = "1" }) })
  check("unknown process id refused", json.decode(r.results.output.data).error == "Refused: this process id is unknown")
  eq("no process id moves nothing", Balances[F.user], before)

  -- Overflow and malformed quantities.
  for _, q in ipairs({ "9007199254740992", "99999999999999999999", "1e3", "0x10", "-5",
                       "1.5", " 5", "0", "", "abc" }) do
    r = send(wallet(F.owner, { Action = "Transfer", Recipient = F.user, Quantity = q }))
    check("quantity '" .. q .. "' refused", r.error ~= nil)
  end
  r = send(wallet(F.user, { Action = "Transfer", Recipient = F.recipient, Quantity = "999991" }))
  eq("more than balance refused", r.error, "Insufficient balance")
  r = send(wallet(F.user, { Action = "Transfer", Recipient = F.user, Quantity = "1" }))
  eq("self transfer refused", r.error, "Cannot transfer to yourself")
  r = send(wallet(F.user, { Action = "Transfer", Recipient = "bad/key+link", Quantity = "1" }))
  eq("bad recipient refused", r.error, "Recipient must be a 43-character address")

  local many = { Action = "Transfer", Recipient = F.recipient, Quantity = "1" }
  for i = 1, 17 do many["X-Tag-" .. i] = "v" end
  r = send(wallet(F.user, many))
  check("over 16 X- tags refused", r.error ~= nil and Balances[F.user] == 999990)

  local total = 0
  for _, v in pairs(Balances) do total = total + v end
  eq("supply invariant holds", total, SUPPLY)
end

--- Paralith's identity rule (rune.lua `actor`): own-scheduler + from-process
--- is that process; any other from-* push, or our scheduler alone, is nobody.
local function identityTests()
  boot()
  local foreignSched = F.stranger
  send(wallet(F.user, { Action = "Transfer", Recipient = F.stranger, Quantity = "50" }))
  send(wallet(F.user, { Action = "Transfer", Recipient = F.sched, Quantity = "50" }))
  local processBefore, strangerBefore = Balances[F.process], Balances[F.stranger]
  eq("signer funded", strangerBefore, 50)
  local foreign = wallet(foreignSched, { Action = "Transfer", Recipient = F.recipient, Quantity = "1",
    ["X-Transfer-Sequence"] = "1" })
  foreign["from-process"] = F.process
  local r = send(foreign)
  eq("foreign-scheduler push is nobody", r.error, "Unsigned messages cannot transfer")
  check("foreign push debits neither process nor signer",
    Balances[F.process] == processBefore and Balances[F.stranger] == strangerBefore)
  for _, stamp in ipairs({ "FromProcess", "From_Process", "from-slot", "From-Base" }) do
    local m = wallet(F.stranger, { Action = "Transfer", Recipient = F.recipient, Quantity = "1" })
    m[stamp] = F.process
    r = send(m)
    eq("foreign " .. stamp .. " stamp is nobody", r.error, "Unsigned messages cannot transfer")
  end
  eq("stamped pushes debit the signer nothing", Balances[F.stranger], strangerBefore)

  r = send(wallet(F.sched, { Action = "Transfer", Recipient = F.recipient, Quantity = "1" }))
  eq("own scheduler without from-process is nobody", r.error, "Unsigned messages cannot transfer")
  eq("own scheduler balance untouched", Balances[F.sched], 50)
  Owner = F.sched
  r = send(wallet(F.sched, { Action = "Admin.Checkpoint" }))
  eq("own scheduler is never the owner", r.error, "Not authorised")
  r = send(delivery(F.process, { Action = "Admin.Checkpoint" }))
  eq("a delivery is never the owner", r.error, "Not authorised")
  Owner = F.owner
  local stampedOwner = wallet(F.owner, { Action = "Admin.Checkpoint" })
  stampedOwner["from-process"] = F.process
  r = send(stampedOwner)
  eq("a push signed with the owner key is not the owner", r.error, "Not authorised")

  -- Vault withdrawal: our scheduler attests the vault process, sequenced.
  r = pay("1")
  eq("own-scheduler delivery is that process", r.From, F.process)
  eq("vault withdrawal debits the process", Balances[F.process], processBefore - 1)
  eq("vault withdrawal is sequenced", TransferStreams[F.process].floor, 1)

  local userBefore = Balances[F.user]
  r = send(wallet(F.user, { Action = "Transfer", Recipient = F.recipient, Quantity = "1" }))
  eq("wallet unchanged", r.From, F.user)
  eq("wallet debited once", Balances[F.user], userBefore - 1)

  -- An unstamped body with two signers is nobody; a stamped one is a push,
  -- named by its admission alone (its signers say nothing either way).
  local dual = wallet(F.user, { Action = "Transfer", Recipient = F.recipient, Quantity = "1" })
  dual.commitments.w = { type = "rsa-pss-sha512", committer = F.stranger, committed = { "target" } }
  r = send(dual)
  eq("dual signer is nobody", r.error, "Unsigned messages cannot transfer")
  eq("dual signer moves nothing", Balances[F.user], userBefore - 1)
  local dualPush = delivery(F.process, { Action = "Transfer", Recipient = F.recipient, Quantity = "1",
    ["X-Transfer-Sequence"] = "2" })
  dualPush.commitments.w = { type = "rsa-pss-sha512", committer = F.user, committed = { "target" } }
  r = send(dualPush, false)
  eq("an unadmitted dual-signed push is nobody", r.error, "Unsigned messages cannot transfer")
  eq("it debits neither signer nor process", Balances[F.process] .. "/" .. Balances[F.user],
    (processBefore - 1) .. "/" .. (userBefore - 1))

  -- Admission (paralith-mono packages/hypertoken/lua/admission.lua). The vault
  -- lives on paralith: its push reaches us signed by paralith's node, and our
  -- scheduler (trusting paralith) admits it. That is the 2026-11-15 fix: the
  -- old rule believed only our own scheduler's signature.
  local foreignNode = string.rep("P", 43)
  r = pay("2", nil, foreignNode)
  eq("admitted push relayed by a trusted foreign node is that process", r.From, F.process)
  eq("admitted foreign push debits the process", Balances[F.process], processBefore - 2)
  local stray = delivery(F.process, { Action = "Transfer", Recipient = F.recipient, Quantity = "1",
    ["X-Transfer-Sequence"] = "3" }, foreignNode)
  r = send(stray, { process = F.process, entry = "other-entry", slot = admitSlot })
  eq("admission for another entry is nobody", r.error, "Unsigned messages cannot transfer")
  r = send(stray, { process = F.process, entry = Admits[stray].entry, slot = admitSlot + 7 })
  eq("admission for another slot is nobody", r.error, "Unsigned messages cannot transfer")
  r = send(stray, { process = F.stranger, entry = Admits[stray].entry, slot = admitSlot })
  eq("admission naming another process is nobody", r.error, "Unsigned messages cannot transfer")
  local inBody = delivery(F.process, { Action = "Transfer", Recipient = F.recipient, Quantity = "1",
    ["X-Transfer-Sequence"] = "3" }, foreignNode)
  inBody["admit-process"], inBody["admit-entry"], inBody["admit-slot"] = F.process, Admits[inBody].entry, Admits[inBody].slot
  r = send(inBody, false)
  eq("admit-* keys in a body admit nothing", r.error, "Unsigned messages cannot transfer")
  local clash = delivery(F.process, { Action = "Transfer", Recipient = F.recipient, Quantity = "1",
    ["X-Transfer-Sequence"] = "3" }, foreignNode)
  clash.FromProcess = F.stranger
  r = send(clash)
  eq("conflicting from-process spellings are nobody", r.error, "Unsigned messages cannot transfer")
  eq("refused admissions move nothing", Balances[F.process], processBefore - 2)
end

local function sequenceTests()
  boot()
  local before = Balances[F.process]

  local r = send(delivery(F.process, { Action = "Transfer", Recipient = F.recipient, Quantity = "1" }))
  eq("process transfer without sequence refused", r.error, "Process transfers require X-Transfer-Sequence")
  check("refused transfer moved nothing", Balances[F.process] == before and TransferStreams[F.process] == nil)

  r = pay("2")
  eq("out-of-order sequence 2 accepted", r.Action, "Transfer-Success")
  check("gap keeps floor at 0", TransferStreams[F.process].floor == 0
    and TransferStreams[F.process].above["2"] == true)
  r = pay("1")
  eq("sequence 1 fills the gap", r.Action, "Transfer-Success")
  check("gap closed: floor 2, above empty",
    TransferStreams[F.process].floor == 2 and next(TransferStreams[F.process].above) == nil)
  eq("two payments debited", Balances[F.process], before - 2)
  eq("stream revision counts paid sequences", TransferStreamRevision, 2)
  eq("streams republished", json.decode(base.transferstreams).senders[F.process].floor, 2)

  local outbox
  r, outbox = pay("3", { ["X-Pair"] = "original-intent", ["X-Reference"] = "payout-3" })
  local original = outbox["credit-notice"]
  eq("credit notice forwards X-Transfer-Sequence", original["X-Transfer-Sequence"], "3")
  eq("transfer reply names the sequence", r.TransferSequence, "3")
  local seqBefore = TransferSeq

  -- Replay within the window: no second payment, one Debit-Notice back to the
  -- sender with the original reference and intent, no second Credit-Notice.
  r, outbox = pay("3", { ["X-Pair"] = "forged-intent", ["X-Reference"] = "payout-3" })
  eq("replay is a duplicate", r.Duplicate, "true")
  eq("replay retained receipt", r.ReceiptRetained, "true")
  eq("replay pays nothing", Balances[F.process], before - 3)
  eq("replay does not advance TransferSeq", TransferSeq, seqBefore)
  local d = outbox["debit-notice"]
  check("replay answers the sender with one Debit-Notice and no Credit-Notice",
    count(outbox) == 1 and outbox["credit-notice"] == nil and d and d.target == F.process)
  check("replayed Debit-Notice: Duplicate, sequence, original reference and intent",
    d.Duplicate == "true" and d.TransferSequence == "3" and d.Reference == original.Reference
      and d["X-Pair"] == "original-intent" and d["X-Reference"] == "payout-3" and d["X-Transfer-Sequence"] == "3")
  r, outbox = pay("3", { Cast = "true" })
  check("a Cast replay is answered with nothing", r.Duplicate == "true" and next(outbox) == nil)

  r = pay("3", { Quantity = "2" })
  check("a paid sequence cannot be reused for another amount", r.error ~= nil and Balances[F.process] == before - 3)
  r = pay("3", { Recipient = F.stranger })
  check("a paid sequence cannot be reused for another recipient", r.error ~= nil)

  -- Replay after the receipt is gone (below the floor): nothing moves, and
  -- the sender still hears back (it used to be silence).
  TransferReceipts, TransferReceiptOrder = {}, {}
  r, outbox = pay("1", { ["X-Reference"] = "payout-1" })
  d = outbox["debit-notice"]
  check("replay without a receipt moves nothing", r.Duplicate == "true" and r.ReceiptRetained == "false"
    and Balances[F.process] == before - 3 and TransferSeq == seqBefore)
  check("replay without a receipt: one Debit-Notice to the sender, no Credit-Notice",
    count(outbox) == 1 and d and d.target == F.process and d.Duplicate == "true"
      and d.TransferSequence == "1" and d["X-Reference"] == "payout-1" and d["X-Transfer-Sequence"] == "1")

  -- Window: floor 3, so 259 is the last allowed sequence.
  r = pay("260")
  check("sequence beyond the 256 window refused without a hole",
    r.error ~= nil and TransferStreams[F.process].above["260"] == nil and Balances[F.process] == before - 3)
  r = pay("259")
  check("sequence at the window edge accepted", r.Action == "Transfer-Success"
    and TransferStreams[F.process].above["259"] == true)
  r = pay("259")
  eq("replay above floor (in window) is a duplicate", r.Duplicate, "true")
  eq("window replay pays nothing", Balances[F.process], before - 4)

  for _, s in ipairs({ "0", "-1", "1.5", "9007199254740992", "99999999999999999999", "abc", " 4", "" }) do
    r = pay(s)
    check("sequence '" .. s .. "' refused", r.error ~= nil)
  end
  r = pay(4)
  check("numeric (non-string) sequence refused", r.error ~= nil)

  local poor = pay("4", { Quantity = tostring(before) })
  check("an unsuccessful payout does not spend its sequence",
    poor.error ~= nil and TransferStreams[F.process].above["4"] == nil and TransferStreams[F.process].floor == 3)
  r = pay("4")
  eq("the unspent sequence pays later", r.Action, "Transfer-Success")

  -- A wallet's X-Transfer-Sequence is just an intent tag (rune.lua parity).
  r = send(wallet(F.user, { Action = "Transfer", Recipient = F.recipient, Quantity = "1",
    ["X-Transfer-Sequence"] = "1" }))
  check("wallet with a sequence tag pays normally", r.Action == "Transfer-Success" and TransferStreams[F.user] == nil)

  -- Streams are per sender.
  Balances[F.stranger] = 5; Balances[F.process] = Balances[F.process] - 5
  r = send(delivery(F.stranger, { Action = "Transfer", Recipient = F.recipient, Quantity = "1",
    ["X-Transfer-Sequence"] = "1" }))
  eq("another process has its own stream", r.Action, "Transfer-Success")
end

local function receiptBoundTests()
  boot()
  for s = 1, 40 do pay(tostring(s)) end
  local mine = 0
  for _, key in ipairs(TransferReceiptOrder) do
    if key:find(F.process, 1, true) then mine = mine + 1 end
  end
  eq("receipts bounded per sender", mine, 32)
  eq("all 40 paid once", Balances[F.process], 1000000 - 40)
  local r = pay("1")
  check("evicted receipt still blocks replay", r.Duplicate == "true" and Balances[F.process] == 1000000 - 40)
end

--- A sender (dao.lua's payout rows) whose Debit-Notice was lost resends the
--- same sequence until one arrives: it settles once, and nothing moves twice,
--- whether the token still holds the receipt or not.
local function lostNoticeTests()
  boot()
  local pending, settled = {}, 0
  local function deliver(outbox)
    local d = outbox["debit-notice"]
    if d and d.target == F.process and pending[d["X-Reference"]] then
      pending[d["X-Reference"]] = nil
      settled = settled + 1
    end
  end
  local before, recipientBefore = Balances[F.process], Balances[F.recipient] or 0
  for _, evict in ipairs({ false, true }) do
    local id = evict and "payout-b" or "payout-a"
    local seq = evict and "2" or "1"
    pending[id] = true
    local _, lost = pay(seq, { ["X-Reference"] = id, Quantity = "5" })
    check(id .. ": first transfer emits a Debit-Notice (lost in transit)", lost["debit-notice"] ~= nil)
    if evict then TransferReceipts, TransferReceiptOrder = {}, {} end
    local r, outbox = pay(seq, { ["X-Reference"] = id, Quantity = "5" })
    check(id .. ": resend is a duplicate", r.Duplicate == "true"
      and r.ReceiptRetained == (evict and "false" or "true"))
    check(id .. ": resend carries no Credit-Notice", outbox["credit-notice"] == nil)
    deliver(outbox)
    check(id .. ": resend settles the payout", pending[id] == nil)
    _, outbox = pay(seq, { ["X-Reference"] = id, Quantity = "5" })
    deliver(outbox)
  end
  eq("each payout settled exactly once", settled, 2)
  eq("sender paid each payout once", Balances[F.process], before - 10)
  eq("recipient credited each payout once", Balances[F.recipient], recipientBefore + 10)
end

local function restoreTests()
  boot()
  pay("1"); pay("2"); pay("5")
  local published = base.transferstreams
  local publishedRevision = base.transferstreamrevision
  eq("published revision", publishedRevision, "3")

  -- Cold streams restore from the checkpoint.
  TransferStreams, TransferStreamRevision = {}, 0
  local r = pay("2")
  eq("restored stream still knows sequence 2 was paid", r.Duplicate, "true")
  check("restored floor and window", TransferStreams[F.process].floor == 2
    and TransferStreams[F.process].above["5"] == true)

  -- Restore never lowers counters: a VM ahead of the published map keeps its own.
  pay("3")
  local live = TransferStreamRevision
  base.transferstreams, base.transferstreamrevision = published, publishedRevision
  base.transferseq = "1"
  r = pay("3")
  eq("stale published streams do not lower the VM", r.Duplicate, "true")
  check("stream revision not lowered", TransferStreamRevision >= live)
  check("TransferSeq not lowered", TransferSeq >= 4)

  -- A checkpoint that does not prove itself refuses everything.
  TransferStreams, TransferStreamRevision = {}, 0
  base.transferstreamrevision = "99"
  r = send(wallet(F.user, { Action = "Info" }))
  check("stale stream checkpoint refuses every action", r.error ~= nil)
  base.transferstreams = nil
  r = send(wallet(F.user, { Action = "Info" }))
  check("missing stream checkpoint on a sequenced-v1 token refuses", r.error ~= nil)
  base.transferstreams = encode({ revision = 99, senders = { [F.process] = { floor = 99, above = { ["999"] = true } } } })
  r = send(wallet(F.user, { Action = "Info" }))
  check("stream window beyond 256 refuses", r.error ~= nil)

  -- Minted is never lowered by a restore.
  reset(goodAllocations())
  send(wallet(F.user, { Action = "Info" }))
  Balances, TotalSupply = {}, 0
  base.tokeninfo = encode({ Minted = "5", Sealed = "true", ProcessTransferProtocol = "sequenced-v1" })
  send(wallet(F.user, { Action = "Info" }))
  eq("restore keeps Minted", Minted, SUPPLY)
  eq("restore rebuilds balances", Balances[F.user], 1000000)
end

local function patchModeTests()
  local previous = Lua53bPatchMode
  Lua53bPatchMode = true
  reset(goodAllocations())
  send(wallet(F.user, { Action = "Info" }))
  check("5.3b genesis publishes balances and witness",
    base.balances ~= nil and base.tokencommit ~= nil and base.totalsupply == "1000000000000000")
  reset(goodAllocations(), true)
  send(wallet(F.user, { Action = "Info" }))
  check("5.3b cold VM after genesis: sealed, no re-mint",
    TotalSupply == SUPPLY and Balances[F.user] == 1000000 and Sealed)
  local r = pay("1")
  eq("5.3b process transfer", r.Action, "Transfer-Success")
  reset(goodAllocations(), true)
  r = pay("1")
  check("5.3b cold VM behind its checkpoint refuses and never re-mints",
    r.error ~= nil and TotalSupply == 0 and next(Balances) == nil and not Sealed, r.error)
  Lua53bPatchMode = previous
end

function runTokenTests()
  local suites = { genesisTests, sealTests, walletTests, identityTests, sequenceTests, receiptBoundTests, lostNoticeTests,
                   restoreTests, patchModeTests }
  for i, suite in ipairs(suites) do
    local ok, err = pcall(suite)
    check("suite " .. i .. " ran", ok, err)
  end
  lines[#lines + 1] = passed .. " passed, " .. failed .. " failed"
  return table.concat(lines, "\n")
end
