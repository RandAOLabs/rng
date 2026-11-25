--- rng-token.lua - RNG, the fixed-supply token that pays for beacon randomness.
---
--- Users fund a balance in the beacon process with it, and validators and the
--- protocol are paid in it. The whole supply (10^15 atoms = 1,000,000,000 RNG at
--- 6 decimals) is minted ONCE, on the first slot, to `GenesisAllocations`, and
--- the token is then sealed: there is no faucet, no mint and no admin power over
--- balances. See docs/PERMISSIONLESS.md (D5, D6, "Token").
---
--- Deploy prelude (prepended to this source):
---   GenesisAllocations = { ["<43-char address>"] = <atoms>, ... }  -- sums to 10^15
---   TokenTicker = "TEST-RNG"                                       -- optional (testnet)
---
--- The ledger, identity and publishing rules are adapted from paralith-mono
--- backend/native/quote.lua; process transfers are a port of rune.lua's
--- `sequenced-v1` streams, which `deploy-dao.mjs` and the Paralith vault require.

local json = require(".json")

Name = TokenName or "RNG"
Ticker = TokenTicker or "RNG"
Denomination = 6
Logo = Logo or ""

--- The whole supply, ever. 10^15 < 2^53, so every balance stays exact.
local GENESIS_SUPPLY = 1000000000000000
local ATOMS_MAX = 9007199254740991 -- 2^53 - 1

Balances = Balances or {}
TotalSupply = TotalSupply or 0
Minted = Minted or 0
--- True once genesis has run (or a prior genesis is proven by published state).
--- Nothing ever mints after this, and nothing ever clears it.
Sealed = Sealed or false

--- Counts the transfers, so every notice this token emits carries an id
--- (`Reference = t<n>`). A recipient process keys its replay guard on
--- `<this process>:<reference>`. NEVER RESET IT: a counter that went backwards
--- would make old references creditable again.
TransferSeq = TransferSeq or 0
ChangedBalances = ChangedBalances or {}
TokenAccountCount = TokenAccountCount or 0
TokenRevision = TokenRevision or 0
TokenCheckpointRevision = TokenCheckpointRevision or 0

local SIGNATURE_ALGS = { ["rsa-pss-sha512"] = true, ["rsa-pss-sha256"] = true, ["ed25519-sha512"] = true }

local function int(v, default)
  if v == nil then return default end
  local n = tonumber(v)
  if not n then return default end
  return math.tointeger(n) or default
end

--- A positive whole number of atoms, below 2^53. Wire tags are strings, so a
--- string must be plain decimal digits: `tonumber` would also take "0x10",
--- "1e3" and " 5", and a float beyond 2^53 is no longer an exact count.
local function quantity(v)
  if v == nil or v == "" then return nil, "Quantity is required" end
  if type(v) == "string" and not v:match("^%d+$") then
    return nil, "Quantity must be a whole atomic amount"
  end
  local n = tonumber(v)
  if not n or n ~= math.floor(n) then return nil, "Quantity must be a whole atomic amount" end
  n = math.tointeger(n)
  if not n or n > ATOMS_MAX then return nil, "Quantity is out of range" end
  if n <= 0 then return nil, "Quantity must be positive" end
  return n
end

local function asString(n) return string.format("%d", int(n, 0)) end
local function balanceOf(address) return int(Balances[address], 0) end

local function credit(address, amount)
  local previous = balanceOf(address)
  local nextBalance = previous + amount
  Balances[address] = nextBalance > 0 and nextBalance or nil
  if nextBalance ~= previous then
    ChangedBalances[address] = true
    if previous <= 0 and nextBalance > 0 then
      TokenAccountCount = int(TokenAccountCount, 0) + 1
    elseif previous > 0 and nextBalance <= 0 then
      TokenAccountCount = math.max(0, int(TokenAccountCount, 0) - 1)
    end
  end
end

--- Identity comes from a signature commitment, and only that.
---
--- The algorithm is read from `type` OR `alg` (a live node writes `type`, the
--- harness `alg`). An hmac commitment is not a signature, so `SIGNATURE_ALGS`
--- is the whole allow-list. Two different signers is no identity at all.
local function provenSigner(msg)
  local c = msg.commitments or msg.Commitments
  if type(c) ~= "table" then return nil end
  local signer = nil
  for _, commitment in pairs(c) do
    if type(commitment) == "table" and commitment.committer
       and SIGNATURE_ALGS[commitment.type or commitment.alg] then
      if signer and signer ~= commitment.committer then return nil end
      signer = commitment.committer
    end
  end
  return signer
end

--- This process's own scheduler. See the identical helper in rune.lua.
local function schedulerAddress(base)
  if type(base) ~= "table" then return nil end
  local found = base["scheduler-location"] or base.SchedulerLocation
    or base["scheduler_location"]
  if type(found) == "string" and #found == 43 then return found end
  local p = base.process or base.Process
  if type(p) == "table" then
    local nested = p["scheduler-location"] or p.SchedulerLocation
    if type(nested) == "string" and #nested == 43 then return nested end
  end
  return nil
end

-- BEGIN hypertoken admission (paralith-mono packages/hypertoken/lua/admission.lua, verbatim)
local HTAdmit = (function(...)
--- admission.lua -- which PROCESS sent a message: exactly what this process's
--- own scheduler admitted for the slot being computed, and nothing else
--- (docs/FOREIGN_SCHEDULERS.md).
---
--- A process has no key, so a push names its origin in `from-*` stamps that the
--- delivering node writes. Whoever signed the body says nothing about origin:
--- a foreign node can sign anything. What counts is the Assignment (`req`)
--- that THIS process's scheduler signs for the slot. When its door admits a
--- delivery under node policy (infra/nodes/trust.json) -- its own push
--- (`local`), a trusted scheduler's (`trusted`), or one it recomputed from the
--- sender's archived schedule (`verified`) -- it writes `admit-*` keys beside
--- the body. The rule is one comparison, the same for all three:
---
---   the body's from-process, from-entry and from-slot (every spelling of each
---   agreeing, the slot narrowed to an integer) equal admit-process,
---   admit-entry and admit-slot on the Assignment.
---
--- `admit-*` keys inside a BODY are never read; only `rawget(req, ...)` is. A
--- stamped body the scheduler did not admit names no process, and is not its
--- signer's word either (a node that relays a push must not act as itself).
--- A wallet is still named by its own real signature, in each contract.
---
--- `capture(req)` runs once at every compute entry and sets the one global,
--- `Admitted`. Every copy of this module in a bundle reads that same global,
--- so the `(msg, base)` callers of each contract's `sourceProcess` stay as
--- they are.
---
--- Loaded as `(function(...) <this file> end)()`. Returns a table. ASCII only;
--- Luerl-safe: no goto, no table.move, every number narrowed.

local A = {}

--- The keys the rule reads, each as `admit-<key>` off the Assignment. The
--- scheduler writes more (`admit-outbox-key`, `-scheduler`, `-policy`,
--- `-policy-epoch`); they stay on the signed Assignment as evidence, and no
--- contract decision reads them.
A.KEYS = { "process", "slot", "entry" }

local function int(v)
  return math.tointeger(tonumber(v))
end

local function isId(s)
  return type(s) == "string" and #s == 43 and s:match("^[%w_%-]+$") ~= nil
end

--- `from-process`, `From_Process` and `FromProcess` are one name.
local function norm(name)
  return (tostring(name):lower():gsub("[-_]", ""))
end

--- The raw body under a tag view that keeps it as `__raw`, or the body itself.
local function raw(msg)
  if type(msg) ~= "table" then return {} end
  local mt = getmetatable(msg)
  if type(mt) == "table" and type(rawget(mt, "__raw")) == "table" then return rawget(mt, "__raw") end
  return msg
end

--- Every `from-*` stamp on a body by normalised name, and true when two
--- spellings of one stamp disagree, which believes nothing.
function A.stamps(msg)
  local out, clash = {}, false
  for k, v in pairs(raw(msg)) do
    if type(k) == "string" and v ~= nil and v ~= "" then
      local n = norm(k)
      if n ~= "from" and n:sub(1, 4) == "from" then
        if out[n] ~= nil and out[n] ~= v then clash = true end
        out[n] = v
      end
    end
  end
  return out, clash
end

--- Does the body carry any `from-*` stamp? Then it is a process delivery and
--- never a wallet's own word, whether or not it was admitted.
function A.pushed(msg)
  return next((A.stamps(msg))) ~= nil
end

--- Read this slot's admission off the Assignment; nil when there is none.
--- Call it first thing in compute, every slot.
function A.capture(req)
  local a = nil
  if type(req) == "table" and rawget(req, "admit-process") ~= nil then
    a = {}
    for _, k in ipairs(A.KEYS) do a[k] = rawget(req, "admit-" .. k) end
  end
  Admitted = a
  return a
end

--- The process a body came from when this slot's admission names exactly it;
--- otherwise nil and why.
function A.source(msg)
  local a = Admitted
  if type(a) ~= "table" then return nil, "Not admitted by this process's scheduler" end
  local s, clash = A.stamps(msg)
  if clash then return nil, "Conflicting from-* stamps" end
  if not isId(s.fromprocess) or s.fromprocess ~= a.process then
    return nil, "from-process is not what this slot admitted"
  end
  if type(s.fromentry) ~= "string" or s.fromentry ~= a.entry then
    return nil, "from-entry is not what this slot admitted"
  end
  local slot = int(s.fromslot)
  if slot == nil or slot ~= int(a.slot) then return nil, "from-slot is not what this slot admitted" end
  return s.fromprocess
end

--- Who acts: the admitted process for a stamped body, nobody for a stamped
--- body that was not admitted, and `signer(msg)` (the contract's own: one real
--- signature, `type` OR `alg`) for an unstamped one.
function A.actor(msg, signer)
  if A.pushed(msg) then return (A.source(msg)) end
  return signer(msg)
end

return A
end)()
-- END hypertoken admission

--- A wallet speaking for itself: the one real signer of a message with no
--- `from-*` stamp (a stamped body is a delivery, never its signer's word).
--- Unlike rune.lua, our own scheduler is never a wallet: its signature
--- without an admitted push attests nothing.
local function walletSigner(msg, base)
  if HTAdmit.pushed(msg) then return nil end
  local signed = provenSigner(msg)
  if signed ~= nil and signed == schedulerAddress(base) then return nil end
  return signed
end

--- Who is spending. A stamped body (any `from-*`) is a process delivery: it is
--- the process this slot's Assignment admitted (admission.lua: own push
--- `local`, a `trusted` scheduler's, or a `verified` one), or nobody -- never
--- the node that relayed it. An unstamped body is its wallet signer.
local function actor(msg, base)
  return HTAdmit.actor(msg, function(m) return walletSigner(m, base) end)
end

--- A wallet or process address: exactly 43 base64url characters. Every holder
--- becomes a row of a published `balances-<n>` bucket, so anything else would
--- corrupt the checkpoint. Same shape as pusd.lua.
local function isAoAddress(s)
  return type(s) == "string" and #s == 43 and s:match("^[%w_%-]+$") ~= nil
end

local function isOwner(address)
  return Owner ~= nil and Owner ~= "" and address ~= nil and address == Owner
end

local function reply(base, value, outbox)
  base.results = {
    output = { data = type(value) == "string" and value or encode(value) },
    outbox = outbox or {},
  }
  return base
end

local function fail(base, message) return reply(base, { error = message }) end

--- Every `X-` tag rides on the notices: it is how a payment carries its reason.
--- Bounded, and a transfer over the bound is REFUSED rather than trimmed (a
--- notice that lost an intent tag is a payment with the wrong reason). Same
--- bounds as rune.lua.
local FORWARD_TAG_LIMIT = 16
local FORWARD_BYTE_LIMIT = 2048

local function forwarded(msg)
  local out, count, bytes = {}, 0, 0
  for k, v in pairs(msg) do
    local key = tostring(k)
    if key:sub(1, 2):lower() == "x-" then
      out[key] = v
      count = count + 1
      bytes = bytes + #key + #tostring(v)
    end
  end
  if count > FORWARD_TAG_LIMIT or bytes > FORWARD_BYTE_LIMIT then
    return nil, "A transfer carries at most 16 X- tags and 2048 bytes of them"
  end
  return out
end

local function isCast(msg)
  local c = msg.Cast
  return c ~= nil and c ~= "" and c ~= "false"
end

local function balancesView()
  local out = jsonObject({})
  for address, amount in pairs(Balances) do
    if int(amount, 0) > 0 then out[address] = asString(amount) end
  end
  return out
end

local function publishedObject(base, key)
  local raw = base and base[key]
  if type(raw) == "table" then return raw end
  if type(raw) ~= "string" or raw == "" or raw == "null" then return nil end
  local ok, decoded = pcall(json.decode, raw)
  return ok and type(decoded) == "table" and decoded or nil
end

-- sequenced-v1: exactly-once process transfers ---------------------------------
--
-- Port of rune.lua (prepareProcessTransfer / commitProcessTransfer /
-- restoreTransferStreams). Every transfer whose payer is an attested process
-- must carry `X-Transfer-Sequence = <n>`. Per sender, `floor` is the highest n
-- below which every sequence has been paid, and `above` the paid ones in
-- (floor, floor + 256]. A paid sequence is a no-op forever; one beyond the
-- window is refused without leaving a hole; a failed transfer spends nothing.
-- Wallet transfers are unchanged.
local TRANSFER_WINDOW = 256
local TRANSFER_SEQUENCE_MAX = ATOMS_MAX
TransferStreams = TransferStreams or {}
--- Sum over senders of (floor + #above): it only ever goes up, and it is the
--- witness that tells a VM whose copy is behind the published one.
TransferStreamRevision = TransferStreamRevision or 0

--- The last notices of recent sequenced transfers, so a sender that resends a
--- sequence it already paid (dao.lua `Resend-Payout`) gets its ORIGINAL
--- Debit-Notice again -- that is what clears its pending row. Bounded in total
--- and per sender, evicting from the largest sender first, so one sender
--- cannot push another's receipts out. Held in memory only: a receipt lost to a
--- cold VM degrades to `ReceiptRetained = false`, never to a second payment.
local RECEIPT_LIMIT = 1024
local RECEIPT_PER_SENDER = 32
TransferReceipts = TransferReceipts or {}
TransferReceiptOrder = TransferReceiptOrder or {}

local function receiptSender(key) return key:match("^@seq:(.-):%d+$") end

local function evictReceipt(index)
  local key = table.remove(TransferReceiptOrder, index)
  if key then TransferReceipts[key] = nil end
end

local function rememberReceipt(from, key, to, amount, reference, tags)
  TransferReceipts[key] = { to = to, amount = asString(amount), reference = reference, forwarded = tags }
  TransferReceiptOrder[#TransferReceiptOrder + 1] = key
  local counts, oldest = {}, {}
  for i, k in ipairs(TransferReceiptOrder) do
    local s = receiptSender(k) or ""
    counts[s] = (counts[s] or 0) + 1
    if not oldest[s] then oldest[s] = i end
  end
  if (counts[from] or 0) > RECEIPT_PER_SENDER then
    evictReceipt(oldest[from])
    return
  end
  if #TransferReceiptOrder > RECEIPT_LIMIT then
    local most, mostCount = nil, -1
    for s, n in pairs(counts) do
      if n > mostCount or (n == mostCount and s < most) then most, mostCount = s, n end
    end
    evictReceipt(oldest[most])
  end
end

local function prepareProcessTransfer(from, msg)
  local raw = msg["X-Transfer-Sequence"] or msg["x-transfer-sequence"]
  if raw == nil then return nil, "Process transfers require X-Transfer-Sequence" end
  if type(raw) ~= "string" or not raw:match("^%d+$") then
    return nil, "X-Transfer-Sequence must be a positive decimal integer"
  end
  local sequence = int(raw, 0)
  if #raw > 16 or sequence < 1 or sequence > TRANSFER_SEQUENCE_MAX then
    return nil, "X-Transfer-Sequence is out of range"
  end
  local stream = TransferStreams[from]
  local floor = stream and int(stream.floor, 0) or 0
  if sequence > floor + TRANSFER_WINDOW then
    return nil, "Transfer sequence exceeds the 256-message window"
  end
  local key = "@seq:" .. from .. ":" .. asString(sequence)
  local receipt = TransferReceipts[key]
  local duplicate = sequence <= floor or (stream ~= nil and stream.above[asString(sequence)] == true)
  if receipt and not duplicate then return nil, "Transfer stream does not match its retained receipt" end
  return { sequence = sequence, key = key, receipt = receipt, duplicate = duplicate }
end

local function commitProcessTransfer(from, sequence)
  local stream = TransferStreams[from]
  if not stream then stream = { floor = 0, above = {} }; TransferStreams[from] = stream end
  stream.above[asString(sequence)] = true
  while stream.above[asString(stream.floor + 1)] do
    stream.floor = stream.floor + 1
    stream.above[asString(stream.floor)] = nil
  end
  TransferStreamRevision = int(TransferStreamRevision, 0) + 1
end

local function streamsView()
  local senders = jsonObject({})
  for source, s in pairs(TransferStreams) do
    senders[source] = { floor = int(s.floor, 0), above = jsonObject(s.above) }
  end
  return { revision = int(TransferStreamRevision, 0), senders = senders }
end

--- Bring the streams up to the published checkpoint. A copy that is behind is
--- replaced only by a checkpoint that proves itself (its revision equals the sum
--- of its floors and window entries); a missing or inconsistent one refuses
--- every action rather than forgetting which sequences were paid. The revision
--- never goes down.
local function restoreTransferStreams(base)
  local expected = int(base and base.transferstreamrevision, 0)
  if base and (base.transferstreams == nil or base.transferstreamrevision == nil)
     and type(base.tokeninfo) == "string" then
    local ok, info = pcall(json.decode, base.tokeninfo)
    if ok and type(info) == "table" and info.ProcessTransferProtocol == "sequenced-v1" then
      return nil, "Transfer stream checkpoint or revision is missing"
    end
  end
  if base and base.transferstreams ~= nil and base.transferstreamrevision == nil then
    return nil, "Transfer stream revision is missing"
  end
  if expected <= int(TransferStreamRevision, 0) then return true end
  local saved = publishedObject(base, "transferstreams")
  if not saved or int(saved.revision, -1) ~= expected or type(saved.senders) ~= "table" then
    return nil, "Transfer stream checkpoint is missing or stale"
  end
  local restored, total = {}, 0
  for source, held in pairs(saved.senders) do
    local floor = type(held) == "table" and int(held.floor, -1) or -1
    if type(source) ~= "string" or #source ~= 43 or floor < 0
       or floor > TRANSFER_SEQUENCE_MAX or type(held.above) ~= "table" then
      return nil, "Invalid transfer stream checkpoint"
    end
    local above, count = {}, 0
    for key, seen in pairs(held.above) do
      local sequence = int(key, -1)
      if seen ~= true or sequence <= floor or sequence > floor + TRANSFER_WINDOW then
        return nil, "Invalid transfer stream window"
      end
      above[asString(sequence)] = true
      count = count + 1
    end
    if count > TRANSFER_WINDOW then return nil, "Transfer stream window is too large" end
    restored[source] = { floor = floor, above = above }
    total = total + floor + count
  end
  if total ~= expected then return nil, "Transfer stream checkpoint does not match its revision" end
  TransferStreams, TransferStreamRevision = restored, expected
  return true
end

-- Recover token globals when HyperBEAM retains the returned map but loses the
-- Luerl `priv` snapshot under concurrent slots. Balances are already published
-- in full; the supply invariant (sum of balances == TotalSupply) tells a warm
-- state from a missing/partial one without overwriting healthy globals.
local function restoreTokenState(base)
  local streamsRestored, streamProblem = restoreTransferStreams(base)
  if not streamsRestored then return nil, streamProblem end
  local publishedTotal = int(base and base.totalsupply, nil)
  if int(TokenAccountCount, 0) == 0 and next(Balances) ~= nil then
    for _ in pairs(Balances) do TokenAccountCount = TokenAccountCount + 1 end
  end

  if Lua53bPatchMode then
    local meta = publishedObject(base, "tokencommit")
    local publishedRevision = int(meta and meta.revision, 0)
    local checkpointRevision = int(meta and meta.checkpointRevision, 0)
    local needsRestore = meta and (int(TokenRevision, 0) < publishedRevision
      or int(TokenAccountCount, 0) < int(meta.accounts, 0)
      or (publishedTotal ~= nil and int(TotalSupply, 0) ~= publishedTotal))
    if not meta and base and base.balances ~= nil and publishedTotal ~= nil
       and next(Balances) == nil and int(TotalSupply, 0) == 0 then
      needsRestore = true
      checkpointRevision = publishedRevision
    end
    if needsRestore then
      if checkpointRevision < publishedRevision then
        return nil, "RNG balance checkpoint is stale"
      end
      local publishedBalances = publishedObject(base, "balances")
      if not publishedBalances or publishedTotal == nil then
        return nil, "RNG balance checkpoint is missing"
      end
      local rebuilt, sum, accounts = {}, 0, 0
      for address, amount in pairs(publishedBalances) do
        local value = int(amount, 0)
        if type(address) == "string" and value > 0 then
          rebuilt[address] = value
          sum = sum + value
          accounts = accounts + 1
        end
      end
      if sum ~= publishedTotal or (meta and accounts ~= int(meta.accounts, -1)) then
        return nil, "RNG balance checkpoint does not match its witness"
      end
      Balances, TotalSupply, TokenAccountCount = rebuilt, publishedTotal, accounts
      local info = publishedObject(base, "tokeninfo")
      Minted = math.max(int(Minted, 0), int(info and info.Minted, publishedTotal))
    end
    TokenRevision = math.max(int(TokenRevision, 0), publishedRevision)
    TokenCheckpointRevision = math.max(int(TokenCheckpointRevision, 0), checkpointRevision)
  else
    local publishedBalances = publishedObject(base, "balances")
    if publishedBalances and publishedTotal ~= nil then
      local liveTotal = 0
      for _, amount in pairs(Balances) do liveTotal = liveTotal + int(amount, 0) end
      if int(TotalSupply, 0) ~= publishedTotal or liveTotal ~= publishedTotal then
        local rebuilt = {}
        for address, amount in pairs(publishedBalances) do
          local value = int(amount, 0)
          if type(address) == "string" and value > 0 then rebuilt[address] = value end
        end
        Balances = rebuilt
        TotalSupply = publishedTotal
        TokenAccountCount = 0
        for _ in pairs(Balances) do TokenAccountCount = TokenAccountCount + 1 end
        local info = publishedObject(base, "tokeninfo")
        Minted = math.max(int(Minted, 0), int(info and info.Minted, publishedTotal))
      end
    end
  end
  TransferSeq = math.max(int(TransferSeq, 0), int(base and base.transferseq, 0))
  return true
end

-- Genesis ------------------------------------------------------------------------

--- Mint the whole supply to `GenesisAllocations`, once, then seal.
---
--- Runs after `restoreTokenState`, so a VM that lost its globals but whose
--- process already published a supply sees that supply (or the published
--- `Sealed`) and seals instead of minting a second time. An allocation that is
--- not exactly 10^15 atoms to valid addresses mints nothing and leaves the
--- process refusing every action: a wrong supply cannot be fixed later.
local function genesis(base)
  if Sealed then return true end
  local info = publishedObject(base, "tokeninfo")
  if int(Minted, 0) > 0 or int(TotalSupply, 0) > 0 or next(Balances) ~= nil
     or int(base and base.totalsupply, 0) > 0
     or (info and (info.Sealed == "true" or info.Sealed == true)) then
    Sealed = true
    return true
  end
  local alloc = GenesisAllocations
  if type(alloc) ~= "table" or next(alloc) == nil then
    return nil, "Genesis allocations are missing"
  end
  local rows, sum = {}, 0
  -- Sorted, as lua-patch@1.0 (Luerl) walks `pairs`: which bad row a refusal
  -- names must not depend on the VM's table order (wasm-patch@1.0 is PUC).
  local addresses = {}
  for address in pairs(alloc) do addresses[#addresses + 1] = address end
  table.sort(addresses, function(a, b)
    if type(a) ~= type(b) then return type(a) < type(b) end
    return a < b
  end)
  for _, address in ipairs(addresses) do
    local atoms = alloc[address]
    if not isAoAddress(address) then
      return nil, "Genesis allocation to an invalid address"
    end
    local amount = quantity(type(atoms) == "number" and math.tointeger(atoms) or atoms)
    if not amount then return nil, "Genesis allocation for " .. address .. " is not a positive atom count" end
    sum = sum + amount
    if sum > GENESIS_SUPPLY then break end
    rows[#rows + 1] = { address, amount }
  end
  if sum ~= GENESIS_SUPPLY then
    return nil, "Genesis allocations must sum to exactly " .. asString(GENESIS_SUPPLY) .. " atoms"
  end
  for _, row in ipairs(rows) do credit(row[1], row[2]) end
  TotalSupply = GENESIS_SUPPLY
  Minted = GENESIS_SUPPLY
  Sealed = true
  GenesisAllocations = nil
  return true
end

local function infoView()
  return {
    Name = Name, Ticker = Ticker, Denomination = asString(Denomination), Logo = Logo,
    TotalSupply = asString(TotalSupply), Minted = asString(Minted),
    Supply = asString(GENESIS_SUPPLY), Sealed = Sealed and "true" or "false",
    ProcessTransferProtocol = "sequenced-v1",
    ProcessTransferSequenceTag = "X-Transfer-Sequence",
    ProcessTransferWindow = asString(TRANSFER_WINDOW),
  }
end

local H = {}
local ForceTokenCheckpoint = false

H["Info"] = function(base) return reply(base, infoView()) end

H["Balance"] = function(base, msg)
  local address = msg.Account or msg.Recipient or actor(msg, base)
  if not address then return fail(base, "No address") end
  return reply(base, { Account = address, Balance = asString(balanceOf(address)), Ticker = Ticker })
end

H["Balances"] = function(base) return reply(base, balancesView()) end

H["Total-Supply"] = function(base)
  return reply(base, { Action = "Total-Supply", Data = asString(TotalSupply),
                       TotalSupply = asString(TotalSupply), Ticker = Ticker })
end

--- Ask for a full balance checkpoint on the next publish. The deployer only,
--- and it moves nothing.
H["Admin.Checkpoint"] = function(base, msg)
  if not isOwner(walletSigner(msg, base)) then return fail(base, "Not authorised") end
  ForceTokenCheckpoint = true
  return reply(base, { checkpoint = true, revision = asString(TokenRevision) })
end

local function noticesFor(from, to, amount, reference, tags)
  local debit = { target = from, Action = "Debit-Notice", Recipient = to,
                  Quantity = amount, Reference = reference }
  local notice = { target = to, Action = "Credit-Notice", Sender = from,
                   Quantity = amount, Reference = reference }
  for k, v in pairs(tags or {}) do debit[k] = v; notice[k] = v end
  return { ["debit-notice"] = debit, ["credit-notice"] = notice }
end

H["Transfer"] = function(base, msg)
  local from = actor(msg, base)
  if not from then return fail(base, "Unsigned messages cannot transfer") end
  local to = msg.Recipient
  if type(to) ~= "string" or to == "" then return fail(base, "Recipient is required") end
  if not isAoAddress(to) then return fail(base, "Recipient must be a 43-character address") end
  if to == from then return fail(base, "Cannot transfer to yourself") end
  local amount, why = quantity(msg.Quantity)
  if not amount then return fail(base, why) end

  local flow
  if HTAdmit.pushed(msg) then
    flow, why = prepareProcessTransfer(from, msg)
    if not flow then return fail(base, why) end
    if flow.duplicate then
      local seen = flow.receipt
      if seen and (seen.to ~= to or seen.amount ~= asString(amount)) then
        return fail(base, "X-Transfer-Sequence was already used for a different transfer")
      end
      local tags = seen and seen.forwarded
      if not tags then
        tags, why = forwarded(msg)
        if not tags then return fail(base, why) end
      end
      -- Applied already, so nothing moves -- but the sender hears back, every
      -- time, receipt or not. A sender re-sends only because its Debit-Notice
      -- never arrived, and that notice is its only proof (dao.lua clears a
      -- payout row on it): answered with silence, the payout stays pending at
      -- the sender for good. One Debit-Notice to the sender, marked Duplicate,
      -- with its sequence and X- tags (the original ones while the receipt is
      -- held); never a second Credit-Notice. Same rule as rune.lua.
      local outbox = {}
      if not isCast(msg) then
        local debit = { target = from, Action = "Debit-Notice", Duplicate = "true",
          TransferSequence = asString(flow.sequence) }
        if seen then debit.Recipient, debit.Quantity, debit.Reference = seen.to, seen.amount, seen.reference end
        for k, v in pairs(tags) do debit[k] = v end
        outbox["debit-notice"] = debit
      end
      if not seen then
        return reply(base, { Action = "Transfer-Success", From = from, Duplicate = "true",
          ReceiptRetained = "false", TransferSequence = asString(flow.sequence) }, outbox)
      end
      return reply(base, { Action = "Transfer-Success", From = from, Recipient = to,
        Quantity = seen.amount, Balance = asString(balanceOf(from)), Duplicate = "true",
        ReceiptRetained = "true", Reference = seen.reference,
        TransferSequence = asString(flow.sequence) }, outbox)
    end
  end

  if balanceOf(from) < amount then return fail(base, "Insufficient balance") end
  local tags
  tags, why = forwarded(msg)
  if not tags then return fail(base, why) end

  credit(from, -amount)
  credit(to, amount)
  TransferSeq = TransferSeq + 1
  local reference = "t" .. asString(TransferSeq)
  if flow then
    commitProcessTransfer(from, flow.sequence)
    rememberReceipt(from, flow.key, to, amount, reference, tags)
  end
  local outbox = isCast(msg) and {} or noticesFor(from, to, asString(amount), reference, tags)
  return reply(base, { Action = "Transfer-Success", From = from, Recipient = to,
                       Quantity = asString(amount), Balance = asString(balanceOf(from)),
                       Reference = reference,
                       TransferSequence = flow and asString(flow.sequence) or nil }, outbox)
end

--- A message must be signed for THIS token: a Transfer signed for another
--- token (an old one, a test one) is refused, not replayed.
-- BEGIN target door (game/kernel/door.lua; copies checked by target-door.test.mjs)
function TargetRefusal(msg, req)
  local c = type(msg) == "table" and (msg.commitments or msg.Commitments) or nil
  if type(c) ~= "table" or next(c) == nil then return nil end
  local algs = { ["rsa-pss-sha512"] = true, ["rsa-pss-sha256"] = true, ["ed25519-sha512"] = true }
  local signatures, ids = {}, {}
  for id, s in pairs(c) do
    if type(s) == "table" and s.committer and algs[s.type or s.alg] then
      signatures[#signatures + 1] = s
      ids[#ids + 1] = id
    end
  end
  if #signatures == 0 then return "Refused: not signed" end
  local self = type(req) == "table" and req.process or nil
  if type(self) ~= "string" or #self ~= 43 then return "Refused: this process id is unknown" end
  if #signatures == 1 and ids[1] == self then return nil end
  if msg.target ~= self then return "Refused: not signed for this process" end
  for _, s in ipairs(signatures) do
    local bound = false
    for _, key in pairs(type(s.committed) == "table" and s.committed or {}) do
      if key == "target" then bound = true end
    end
    if not bound then return "Refused: the signature does not commit target" end
  end
  return nil
end
-- END target door

local ENVELOPE = {
  target = true, id = true, owner = true, signature = true, anchor = true,
  commitments = true, from = true, type = true, variant = true,
  path = true, method = true, slot = true, device = true, nonce = true,
  epoch = true, accept = true, scheduler = true, subject = true,
  ["from-process"] = true, ["data-protocol"] = true, ["content-type"] = true,
  ["accept-bundle"] = true, ["random-seed"] = true, ["hashpath"] = true,
  fromprocess = true, tags = true,
}

--- The message as handlers see it (the beacon's rule, anyhonest.lua). Envelope
--- fields (commitments, from-process) come only from the body the node
--- verified; a `Tags` table adds tags but never replaces the body or an
--- envelope field, so it cannot forge a signer or a process payer.
local function caseInsensitive(raw)
  local t, named = {}, {}
  for k, v in pairs(raw) do if k ~= "Tags" then t[k] = v; named[tostring(k):lower()] = true end end
  -- A tag never shadows a body field in another case: the node's body keys
  -- are lowercase ("quantity"), and a "Quantity" tag would otherwise win.
  if type(raw.Tags) == "table" then
    for k, v in pairs(raw.Tags) do
      local key = tostring(k):lower()
      if not named[key] and not ENVELOPE[key] then t[k] = v; named[key] = true end
    end
  end
  local lower = {}
  for k, v in pairs(t) do
    local key = tostring(k):lower()
    if not ENVELOPE[key] then lower[key] = v end
  end
  return setmetatable({}, {
    __index = function(_, key) return t[key] or lower[tostring(key):lower()] end,
    __pairs = function() return pairs(t) end,
  })
end

--- Published balances, FOLDED (rune.lua's rule, verbatim). One published key
--- per holder (`balance-<address>`) made every slot pay for every holder the
--- token ever had: 10,031 keys at 9,617 holders (11-18). They fold into
--- BALANCE_BUCKETS keys `balances-<n>`, each a JSON object address -> atoms
--- ("<integer>") holding only the accounts with a balance; an absent address
--- holds 0. n = the sum of the address's first four bytes mod BALANCE_BUCKETS,
--- the rule of paralith-mono's `tokenBalanceKey` (packages/sdk/src/
--- folded-keys.mjs): change them together. A slot rewrites only the buckets
--- its changed balances fall in. `balances` (no suffix) stays the 5.3b
--- checkpoint, written only when one is due.
---
--- 256 buckets: a Transfer rewrites two whole buckets, so the bucket size is
--- the bytes every slot writes. Measured at 10,000 holders (free ~lua@5.3a,
--- a full collect per slot): 32 buckets ~34.3 KB written per Transfer and
--- 30 ms of Lua, 128 ~7.8 KB and 22 ms, 256 ~4.6 KB and 15 ms. A fixed 256
--- keys, whatever the holder count.
local BALANCE_BUCKETS = 256

local function balanceBucket(address)
  local a, b, c, d = string.byte(address, 1, 4)
  return ((a or 0) + (b or 0) + (c or 0) + (d or 0)) % BALANCE_BUCKETS
end

--- The fold's index -- each bucket's members, sorted lists and encoded rows --
--- derived from exactly one `Balances` table: a restore that replaces it
--- rebuilds the index and republishes every bucket.
local Fold = { balances = nil }

local function foldPublish(result)
  if Fold.balances ~= Balances then
    Fold.balances, Fold.members, Fold.sorted, Fold.rows = Balances, {}, {}, {}
    for b = 0, BALANCE_BUCKETS - 1 do Fold.members[b] = {} end
    for address, amount in pairs(Balances) do
      if isAoAddress(address) and int(amount, 0) > 0 then
        Fold.members[balanceBucket(address)][address] = true
      end
    end
    Fold.dirty = {}
    for b = 0, BALANCE_BUCKETS - 1 do Fold.dirty[b] = true end
  end
  -- Only an address is ever a member: a `+link` or `/` in anything published
  -- bricks the process on reload.
  for address in pairs(ChangedBalances) do
    if isAoAddress(address) then
      local b = balanceBucket(address)
      Fold.dirty[b] = true
      Fold.rows[address] = nil
      local holds = balanceOf(address) > 0
      if (Fold.members[b][address] == true) ~= holds then
        Fold.members[b][address] = holds or nil
        Fold.sorted[b] = nil
      end
    end
  end
  for b = 0, BALANCE_BUCKETS - 1 do
    if Fold.dirty[b] then
      local list = Fold.sorted[b]
      if not list then
        list = {}
        for address in pairs(Fold.members[b]) do list[#list + 1] = address end
        table.sort(list)
        Fold.sorted[b] = list
      end
      local parts = {}
      for i, address in ipairs(list) do
        local text = Fold.rows[address]
        if not text then
          text = '"' .. address .. '":"' .. asString(balanceOf(address)) .. '"'
          Fold.rows[address] = text
        end
        parts[i] = text
      end
      result["balances-" .. asString(b)] = "{" .. table.concat(parts, ",") .. "}"
    end
  end
  Fold.dirty = {}
end

local function resolveOwner(base)
  if Owner and Owner ~= "" then return Owner end
  local p = base and (base.process or base.Process)
  if type(p) == "table" then Owner = provenSigner(p) end
  return Owner
end

--- Find a handler by name, ignoring case. Exact wins.
local ACTION_ALIASES = nil
local function resolveHandler(action)
  if H[action] then return H[action] end
  if ACTION_ALIASES == nil then
    ACTION_ALIASES = {}
    for name, fn in pairs(H) do ACTION_ALIASES[tostring(name):lower()] = fn end
  end
  return ACTION_ALIASES[tostring(action):lower()]
end

function compute(base, req, opts)
  base = type(base) == "table" and base or {}
  -- This slot's admission, before anything reads a push (admission.lua).
  HTAdmit.capture(req)
  ChangedBalances = {}
  ForceTokenCheckpoint = false
  local restored, problem = restoreTokenState(base)
  if restored then restored, problem = genesis(base) end
  resolveOwner(base)
  local beforeTotal = int(TotalSupply, 0)
  local beforeTransferSeq = int(TransferSeq, 0)
  local beforeStreamRevision = int(TransferStreamRevision, 0)
  local raw = (req and req.body) or {}
  raw = type(raw) == "table" and raw or {}
  local msg = caseInsensitive(raw)
  local action = msg.Action or msg.action or "none"
  local handler = resolveHandler(action)
  local refused = TargetRefusal(raw, req)
  local result
  if problem then
    result = fail(base, problem)
  elseif refused then
    result = fail(base, refused)
  elseif not handler then
    result = fail(base, "unknown action '" .. tostring(action) .. "'")
  else
    local ok, out = pcall(function() return handler(base, msg) end)
    result = ok and out or fail(base, tostring(out))
  end
  if problem then
    -- Publish nothing: a process that cannot prove its supply must not look healthy.
    collectgarbage("collect")
    return result
  end
  local initial = result.tokeninfo == nil or result.ticker == nil
  local witnessMissing = Lua53bPatchMode and result.tokencommit == nil
  local streamsMissing = result.transferstreamrevision == nil
  local balancesChanged = next(ChangedBalances) ~= nil
  if Lua53bPatchMode and balancesChanged then
    TokenRevision = int(TokenRevision, 0) + 1
  end
  local checkpoint = Lua53bPatchMode
    and (initial or witnessMissing or ForceTokenCheckpoint)
  -- Genesis runs before the handler; it is the only thing that moves the supply.
  local supplyChanged = beforeTotal ~= int(TotalSupply, 0) or result.totalsupply == nil
  local transferChanged = beforeTransferSeq ~= int(TransferSeq, 0)
  if not Lua53bPatchMode or initial then
    result.tokeninfo = encode(infoView())
  end
  if not Lua53bPatchMode or checkpoint then
    if Lua53bPatchMode then TokenCheckpointRevision = int(TokenRevision, 0) end
    result.balances = encode(balancesView())
  end
  if not Lua53bPatchMode or initial or supplyChanged then
    result.totalsupply = asString(TotalSupply)
  end
  if not Lua53bPatchMode or initial then result.ticker = Ticker end
  if not Lua53bPatchMode or initial or transferChanged then
    result.transferseq = asString(TransferSeq)
  end
  if initial or streamsMissing or beforeStreamRevision ~= int(TransferStreamRevision, 0) then
    result.transferstreamrevision = asString(TransferStreamRevision)
    result.transferstreams = encode(streamsView())
  end
  if Lua53bPatchMode
     and (initial or witnessMissing or balancesChanged or ForceTokenCheckpoint) then
    result.tokencommit = encode({
      accounts = int(TokenAccountCount, 0), revision = int(TokenRevision, 0),
      checkpointRevision = int(TokenCheckpointRevision, 0),
    })
  end
  -- Balances, folded (`balances-<n>`): only the buckets this message changed
  -- (genesis included) are rewritten. Both devices.
  foldPublish(result)
  -- Compact the heap before the node photographs it (see game.lua's compute):
  -- a full `collect`, as a bare statement, never inside a pcall frame.
  collectgarbage("collect")

  return result
end
