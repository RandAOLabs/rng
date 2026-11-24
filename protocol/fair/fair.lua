-- fair.lua (process): fair play as its own process (docs/PERMISSIONLESS.md, D12).
--
-- A thin shell over lib/fair.lua: identity, the target door, state persistence
-- and publishing. Games that want to save the hop embed lib/fair.lua instead.
--
-- Messages (tags):
--   Fair.Open { Session, Player }                        the game (wallet signer or attested process):
--                                                         lets key Player commit to Session (10 min);
--                                                         any game, paying: reserves one request price
--                                                         from its balance, else Game-Unfunded
--   Fair.Commit { Game, Session, Commit }                signed by the player key P, after Fair.Open
--     No message carries a time: every time is the scheduler's, and a copy
--     of a signed message is refused by the scheduler (once per process).
--   Fair.Reveal { Game, Session, Secret [, Player] }      anyone (Player defaults to the signer)
--   Fair.Expire { Game, Session, Player }                 anyone, after revealBy
--   RNG-Result / RNG-Error                                the configured beacon only (attested)
--   Credit-Notice { Sender, Quantity, Reference,         the configured token only (attested): funds
--                   X-Fair-Game | X-For }                 that game's balance (default: Sender)
--   Fair.Withdraw { Nonce, Quantity }                     the game: free balance back (atoms, required);
--                                                         Nonce strictly increasing per game
--   Fair.Configure { Beacon, Token, Request-Price, Fair-Window-Ms, Keep,  an owner (the wallet
--                    Max-Open, Min-Interval-Ms, Max-Games, Max-Per-Game }  or the DAO);
--     as tags (any spelling of case, - and _), or in Data (JSON) from the
--     wallet only. beacon and token are fixed once set; requestPrice is the
--     beacon's (whole RNG) and must follow a governance change of it. Pay at
--     deposit: a game's balance opens sessions at the price it was credited
--     at, so a requestPrice change is harmless. From the DAO, naming the
--     beacon or token is money: it waits for Effective-At >= receipt + 24 h
--     (Gov.Apply); the rest applies at once.
--   Gov.Set-Dao / Gov.Renounce-Wallet / Gov.Approve-Code / Gov.Upgrade
--     vendor/gov.lua. The launch wallet bootstraps and renounces; then the
--     DAO (a from-process our scheduler attests) is the only owner. Its
--     Gov.Set-Dao and Gov.Approve-Code wait for Effective-At like money.
--   Gov.Apply { Gov-Id } (anyone, once due) / Gov.Cancel { Gov-Id } (an owner)
--     Games withdraw their free balance at any time (Fair.Withdraw), so the
--     exit hatch here is that and nothing more.
--   Get-Info                                              anyone; also sends a due request
-- Sends: Request-Random -> beacon (from this process's beacon balance, a float
--        topped up from the games' payment after every bound batch),
--        Transfer -> token (top-up, refund, withdrawal; X-Transfer-Sequence),
--        Fair-Result -> Game, only a process game (its Fair.Open attested by our
--        scheduler); a wallet game reads fairsessions / fairhistory instead.
-- Publishes: fairsessions, fairbatches, fairaccounts, fairinfo, fairstate, fairrev,
--   fairhistory (resolved session / bound batch -> slot, the last 1024).
--
-- Native ~lua@5.3a contract, the beacon's conventions. Bundled after
-- vendor/json.lua, vendor/jsonenc.lua (encode, jsonObject), lib/rng.lua
-- (global `rng`), lib/fair.lua (global `fair`), vendor/sha256.lua and
-- vendor/gov.lua (globals `Gov`, `GovState`).

local json = require(".json")
local SIGNATURE_ALGS = { ["rsa-pss-sha512"] = true, ["rsa-pss-sha256"] = true, ["ed25519-sha512"] = true }

--- gov.lua's owner record (GovState) at spawn: the wallet on, no DAO.
local function freshOwners(wallet)
  return { dao = "", wallet = wallet, approved = "", approvedAt = 0, code = { sha = "", version = 0 } }
end

-- gov: the DAO's actions waiting for their Effective-At (vendor/gov.lua QUEUE HELPERS).
Fair = Fair or { rev = 0, owner = "", owners = freshOwners(true), gov = { pending = {}, nextId = 1 },
  state = fair.new({ metered = true }) }

local function deepCopy(v)
  if type(v) ~= "table" then return v end
  local t = {}
  for k, x in pairs(v) do t[k] = deepCopy(x) end
  return t
end

local function deflate(v)
  if type(v) == "number" then return math.tointeger(v) or v end
  if type(v) ~= "table" then return v end
  for k, x in pairs(v) do v[k] = deflate(x) end
  return v
end

--- Published per game, flat per message. A state change used to deep-copy
--- and re-encode every session, account and the history (wasm-patch, a
--- funded Fair.Open: 7 ms empty, 92 ms at 1,000 open sessions, 1.4 s and
--- 6 MB published at 10,000). Now sessions and accounts are published in
--- SHARDS keys each, `fairsessions-<n>` / `fairaccounts-<n>` (n = FNV-1a of
--- the game mod SHARDS: lib/js fairShardKey), and a message rewrites only the
--- shards of the games it touched; `fairstate`, the whole state, is a recovery
--- checkpoint every CHECKPOINT_EVERY changes (anyhonest.lua's rule).
local SHARDS = 256
local CHECKPOINT_EVERY = 1000

local function shardOf(game)
  local h = 2166136261
  for i = 1, #game do h = ((h ~ string.byte(game, i)) * 16777619) & 0xffffffff end
  return h % SHARDS
end

--- Derived from exactly one state (never published, never copied): game ->
--- its session keys, shard -> its games with sessions, shard -> its games
--- with an account. A state that is replaced (a restore, a rollback by copy)
--- is indexed again and every shard republished.
local Index = { sessions = nil }
local Dirty = {}

local function indexOf(st)
  if Index.sessions == st.sessions and Index.accounts == st.accounts then return Index end
  Index = { sessions = st.sessions, accounts = st.accounts, keys = {}, sessionShards = {}, accountShards = {}, all = true }
  for k, sess in pairs(st.sessions) do
    local game = sess.game
    Index.keys[game] = Index.keys[game] or {}
    Index.keys[game][k] = true
    local n = shardOf(game)
    Index.sessionShards[n] = Index.sessionShards[n] or {}
    Index.sessionShards[n][game] = true
  end
  for game in pairs(st.accounts or {}) do
    local n = shardOf(game)
    Index.accountShards[n] = Index.accountShards[n] or {}
    Index.accountShards[n][game] = true
  end
  return Index
end

--- lib/fair.lua's observer: a game whose sessions or account may have
--- changed, and every session added (sess) or dropped (false).
fair.watch = function(game, k, sess)
  if type(game) ~= "string" then return end
  Dirty[game] = true
  local st = Fair.state
  local ix = indexOf(st)
  local n = shardOf(game)
  if st.accounts and st.accounts[game] then
    ix.accountShards[n] = ix.accountShards[n] or {}
    ix.accountShards[n][game] = true
  end
  if k == nil then return end
  local keys = ix.keys[game] or {}
  ix.keys[game] = keys
  keys[k] = sess and true or nil
  ix.sessionShards[n] = ix.sessionShards[n] or {}
  ix.sessionShards[n][game] = next(keys) ~= nil or nil
end

--- The changed shards into `result` (all of them after a re-index).
local function publishShards(result, st)
  local ix = indexOf(st)
  -- A new account (credited before any session) is indexed here too.
  for game in pairs(Dirty) do
    if st.accounts and st.accounts[game] then
      local n = shardOf(game)
      ix.accountShards[n] = ix.accountShards[n] or {}
      ix.accountShards[n][game] = true
    end
  end
  local sessionShards, accountShards = {}, {}
  if ix.all then
    for n = 0, SHARDS - 1 do sessionShards[n], accountShards[n] = true, true end
    ix.all = nil
  else
    for game in pairs(Dirty) do local n = shardOf(game); sessionShards[n], accountShards[n] = true, true end
  end
  Dirty = {}
  for n in pairs(sessionShards) do
    local out = {}
    for game in pairs(ix.sessionShards[n] or {}) do
      local list = {}
      for k in pairs(ix.keys[game] or {}) do
        local sess = st.sessions[k]
        if sess then list[#list + 1] = fair.view(sess) end
      end
      -- fair.sessionsView's order.
      table.sort(list, function(a, b)
        if a.committedAt ~= b.committedAt then return a.committedAt < b.committedAt end
        return a.session .. a.player < b.session .. b.player
      end)
      if #list > 0 then out[game] = list end
    end
    result["fairsessions-" .. n] = next(out) and encode(jsonObject(out)) or nil
  end
  for n in pairs(accountShards) do
    local out = {}
    for game in pairs(ix.accountShards[n] or {}) do
      local a = st.accounts and st.accounts[game]
      if a then out[game] = { balance = a.balance, reserved = a.reserved, nonce = a.nonce } end
    end
    result["fairaccounts-" .. n] = next(out) and encode(jsonObject(out)) or nil
  end
end

local function restore(base)
  if tonumber(base.fairrev or "0") <= Fair.rev then return false end
  local ok, saved = pcall(json.decode, base.fairstate or "")
  if ok and type(saved) == "table" then
    local st = fair.new({ metered = true })
    for k, v in pairs(deflate(saved.state or {})) do st[k] = v end
    -- A published state without owners has none: never re-arm the wallet.
    local owners = type(saved.owners) == "table" and deflate(saved.owners) or freshOwners(false)
    local gov = type(saved.gov) == "table" and deflate(saved.gov) or { pending = {}, nextId = 1 }
    -- The checkpoint may be older than the last change published (fairrev):
    -- this VM continues from it, counting on from fairrev.
    local rev = math.max(math.tointeger(saved.rev) or 0, math.tointeger(tonumber(base.fairrev or "0")) or 0)
    Fair = { rev = rev, owner = saved.owner or "", owners = owners, gov = gov, state = st }
    return true
  end
  return false
end

--- gov.lua reads and writes the global GovState; point it at the state's
--- owner record, so owners are published and restored with the state. Code
--- installed in a VM that is gone is not running here (the spawn module
--- is): its root comes back approved, for anyone to resend.
local function bindOwners(reloaded)
  local o = Fair.owners
  if type(o) ~= "table" then o = freshOwners(false); Fair.owners = o end
  if type(o.code) ~= "table" then o.code = { sha = "", version = 0 } end
  if reloaded and (o.code.sha or "") ~= "" then
    if (o.approved or "") == "" then o.approved, o.approvedAt = o.code.sha, 0 end
    o.code = { sha = "", version = math.tointeger(o.code.version) or 0 }
  end
  o.approvedAt = math.tointeger(o.approvedAt) or 0
  GovState = o
end

--- The owner record and the pending queue as one string, to tell whether a
--- message changed either.
local function ownersKey()
  local o, g = Fair.owners, Fair.gov or {}
  local n = 0
  for _ in pairs(type(g.pending) == "table" and g.pending or {}) do n = n + 1 end
  return table.concat({ tostring(o.dao), tostring(o.wallet), tostring(o.approved), tostring(o.approvedAt),
    tostring(o.code.sha), tostring(o.code.version), tostring(g.nextId), tostring(n) }, "|")
end

--- A message must be signed for THIS process, so a commit or reveal signed
--- for another fair process is refused, not replayed.
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

--- The one RSA signer; nil when unsigned or when two signers disagree.
local function provenSigner(msg)
  local c = msg.commitments
  if type(c) ~= "table" then return nil end
  local found
  for _, commitment in pairs(c) do
    if type(commitment) == "table" and commitment.committer and SIGNATURE_ALGS[commitment.type or commitment.alg] then
      if found and found ~= commitment.committer then return nil end
      found = commitment.committer
    end
  end
  return found
end

local function schedulerAddress(base)
  local found = base["scheduler-location"]
  if type(found) == "string" and #found == 43 then return found end
  local p = base.process
  if type(p) == "table" and type(p["scheduler-location"]) == "string" then return p["scheduler-location"] end
  return nil
end

--- A wallet is its signer; a process is the `from-process` our own scheduler
--- vouches for. A scheduler-signed message without from-process is nobody.
--- Returns (who, fromProcess).
local function actor(msg, base)
  local signed = provenSigner(msg)
  local fromProcess = msg["from-process"]
  if not signed then return nil, false end
  if signed == schedulerAddress(base) then
    if type(fromProcess) == "string" and fromProcess ~= "" then return fromProcess, true end
    return nil, false
  end
  return signed, false
end

local function resolveOwner(base)
  if Fair.owner ~= "" then return Fair.owner end
  local p = base.process
  local c = type(p) == "table" and p.commitments or nil
  if type(c) == "table" then
    for _, commitment in pairs(c) do
      if type(commitment) == "table" and commitment.committer and SIGNATURE_ALGS[commitment.type or commitment.alg] then
        Fair.owner = commitment.committer
        break
      end
    end
  end
  return Fair.owner
end

--- Tag lookup that ignores case; envelope fields come from the body only.
local function fields(raw)
  local t = {}
  for k, v in pairs(raw) do if k ~= "Tags" then t[k] = v end end
  if type(raw.Tags) == "table" then
    for k, v in pairs(raw.Tags) do
      local lk = tostring(k):lower()
      if t[k] == nil and lk ~= "commitments" and lk ~= "from-process" and lk ~= "target" then t[k] = v end
    end
  end
  local lower = {}
  for k, v in pairs(t) do lower[tostring(k):lower()] = v end
  return setmetatable({}, { __index = function(_, k) return t[k] or lower[tostring(k):lower()] end })
end

--- gov.lua's verbs, answered by Gov.handle over the request as delivered.
local GOV_VERBS = { ["gov.setdao"] = true, ["gov.renouncewallet"] = true, ["gov.approvecode"] = true,
  ["gov.upgrade"] = true }
-- The wallet owner is the spawn signer (Fair.owner), not the global Owner.
Gov.walletOwner = function(base) local o = resolveOwner(base); return o ~= "" and o or nil end
-- Gov.Renounce-Wallet is refused while this queue holds an action.
Gov.queue = function()
  Fair.gov = type(Fair.gov) == "table" and Fair.gov or {}
  return Gov.queueOf(Fair.gov)
end

local function reply(base, value, outbox)
  local out = {}
  for name, m in pairs(outbox or {}) do
    if type(m.Data) == "table" then m.Data = encode(m.Data) end
    out[name] = m
  end
  base.results = { output = { data = encode(value) }, outbox = out }
  return base
end

local CONFIG_KEYS = { "beacon", "token", "requestPrice", "fairWindowMs", "keep", "maxOpen", "minIntervalMs",
  "maxGames", "maxPerGame" }
local function norm(k) return (tostring(k):lower():gsub("[%-_]", "")) end

--- Fair.Configure's arguments: tags in any spelling of case, - and _ (a tag
--- spelled twice with two values is refused), or Data (JSON) from the wallet
--- only, where no tag gives one. A whole-number tag is read as an integer.
local function configArgs(raw, who)
  local want = {}
  for _, k in ipairs(CONFIG_KEYS) do want[norm(k)] = k end
  local d, seen = {}, {}
  local function take(k, v)
    local name = want[norm(k)]
    if not name then return true end
    if type(v) == "string" and v:match("^%d+$") and #v <= 15 then v = math.tointeger(tonumber(v)) end
    if seen[name] and d[name] ~= v then return false end
    seen[name], d[name] = true, v
    return true
  end
  for k, v in pairs(raw) do
    if type(k) == "string" and k ~= "Tags" and not take(k, v) then return nil, "Bad-Parameter" end
  end
  if type(raw.Tags) == "table" then
    for k, v in pairs(raw.Tags) do
      if type(k) == "string" and raw[k] == nil and not take(k, v) then return nil, "Bad-Parameter" end
    end
  end
  local data = raw.Data or raw.data
  if who == "wallet" and data ~= nil and data ~= "" then
    local ok, j = pcall(json.decode, data)
    if not ok or type(j) ~= "table" then return nil, "Bad-Config" end
    for k, v in pairs(j) do
      local name = want[norm(k)]
      if name and d[name] == nil then d[name] = v end
    end
  end
  return d
end

local function configure(raw, who)
  if who == nil then return nil, "Not authorised" end
  local d, why = configArgs(raw, who)
  if not d then return nil, why end
  local st, B = Fair.state, fair.BOUNDS
  local function bounded(v, b) v = math.tointeger(v); return v and v >= b[1] and v <= b[2] and v or nil end
  if d.beacon ~= nil then
    if type(d.beacon) ~= "string" or #d.beacon ~= 43 then return nil, "Bad-Parameter" end
    if st.beacon ~= "" and st.beacon ~= d.beacon then return nil, "Beacon-Locked" end
  end
  if d.token ~= nil then
    if type(d.token) ~= "string" or #d.token ~= 43 or not d.token:match("^[%w_%-]+$") then return nil, "Bad-Parameter" end
    if st.token ~= "" and st.token ~= d.token then return nil, "Token-Locked" end
  end
  local rp = d.requestPrice ~= nil and bounded(d.requestPrice, B.requestPrice)
  local w = d.fairWindowMs ~= nil and bounded(d.fairWindowMs, B.windowMs)
  local k = d.keep ~= nil and bounded(d.keep, B.keep)
  local m = d.maxOpen ~= nil and bounded(d.maxOpen, B.maxOpen)
  local mi = d.minIntervalMs ~= nil and bounded(d.minIntervalMs, B.minIntervalMs)
  local mg = d.maxGames ~= nil and bounded(d.maxGames, B.maxGames)
  local mp = d.maxPerGame ~= nil and bounded(d.maxPerGame, B.maxPerGame)
  if w == nil or k == nil or m == nil or mi == nil or mg == nil or mp == nil or rp == nil then
    return nil, "Bad-Parameter"
  end
  st.changes = (st.changes or 0) + 1
  if d.beacon then st.beacon = d.beacon end
  if d.token then st.token = d.token end
  if rp then st.price = rp * st.unit end
  if w then st.windowMs = w end
  if k then st.keep = k end
  if m then st.maxOpen = m end
  if mi then st.minIntervalMs = mi end
  if mg then st.maxGames = mg end
  if mp then st.maxPerGame = mp end
  return { ok = true, beacon = st.beacon, token = st.token, requestPriceAtoms = st.price, fairWindowMs = st.windowMs,
    keep = st.keep, maxOpen = st.maxOpen, minIntervalMs = st.minIntervalMs, maxGames = st.maxGames,
    maxPerGame = st.maxPerGame }, {}
end

--- Money: the beacon or token named while unset, and Gov.Set-Dao. A
--- requestPrice change is harmless: game balances keep the price they were
--- credited at (pay at deposit, lib/fair.lua).
local function fairClass(verb, raw)
  if verb == "gov.setdao" then return "money" end
  local d = configArgs(raw, "dao")
  if not d then return "harmless" end -- refused on the dry run
  local st = Fair.state
  if (d.beacon ~= nil and st.beacon == "") or (d.token ~= nil and st.token == "") then return "money" end
  return "harmless"
end

local function applyFair(verb, raw)
  if verb == "gov.setdao" then
    local dao = raw.Dao or raw.dao
    if type(dao) ~= "string" or #dao ~= 43 or not dao:match("^[%w_%-]+$") then
      return nil, "Dao must be a 43-character process id"
    end
    GovState.dao = dao
    return { ok = true, dao = dao }, {}
  end
  return configure(raw, "dao")
end

local NOT_ARGS = { commitments = true, ["from-process"] = true, target = true, data = true, tags = true,
  ["effective-at"] = true, ["x-dao-proposal"] = true, id = true, slot = true, timestamp = true }

--- The DAO's Fair.Configure or Gov.Set-Dao: harmless with no later
--- Effective-At applies now; otherwise a dry run on a copy, then its
--- Effective-At, then stored for Gov.Apply.
local function propose(verb, raw, now)
  local class = fairClass(verb, raw)
  local v = raw["Effective-At"] or raw["effective-at"]
  local later = v ~= nil and (math.tointeger(tonumber(v)) or 0) > now
  if class == "harmless" and not later then return applyFair(verb, raw) end
  local realSt, realOwners = Fair.state, GovState
  Fair.state, GovState = deepCopy(realSt), deepCopy(realOwners)
  local ok, d, why = pcall(applyFair, verb, raw)
  Fair.state, GovState = realSt, realOwners
  if not ok then error(d, 0) end
  if d == nil then return nil, why end
  local at, err = Gov.when(raw, class, now)
  if not at then return nil, err, { class = class, earliest = class == "money" and now + Gov.EXIT_FLOOR_MS or nil } end
  local args, parts = {}, {}
  for k, x in pairs(raw) do
    if type(k) == "string" and type(x) == "string" and not NOT_ARGS[k:lower()] then
      args[k] = x
      if k:lower() ~= "action" then parts[#parts + 1] = k .. "=" .. x end
    end
  end
  table.sort(parts)
  local e, serr = Gov.schedule(Gov.queueOf(Fair.gov), { verb = verb, class = class, effectiveAt = at, args = args,
    summary = (verb == "gov.setdao" and "Gov.Set-Dao " or "Fair.Configure ") .. table.concat(parts, " "):sub(1, 256) }, now)
  if not e then return nil, serr end
  return { pending = { id = e.id, verb = verb == "gov.setdao" and "Gov.Set-Dao" or "Fair.Configure", class = class,
    effectiveAt = at } }, {}
end

local function govApply(raw, now)
  local q = Gov.queueOf(Fair.gov)
  local e, key = Gov.due(q, raw["Gov-Id"] or raw["gov-id"], now)
  if not e then return nil, key end
  local d, why = applyFair(e.verb, e.args)
  if d == nil then
    -- Refused: it stays pending but no longer holds the exit hatch open.
    e.refused = true
    Fair.state.changes = (Fair.state.changes or 0) + 1
    return nil, why, { govId = e.id }
  end
  q.pending[key] = nil
  d.applied = e.id
  return d, {}
end

local function govCancel(raw, who)
  if who == nil then return nil, "Not authorised" end
  local id = raw["Gov-Id"] or raw["gov-id"]
  if tostring(id):lower() == "code" then
    if not Gov.cancelCode() then return nil, "Unknown-Gov-Id" end
    return { cancelled = "code" }, {}
  end
  local n = math.tointeger(tonumber(id))
  local key = n and string.format("%d", n) or ""
  local q = Gov.queueOf(Fair.gov)
  if not q.pending[key] then return nil, "Unknown-Gov-Id" end
  q.pending[key] = nil
  return { cancelled = n }, {}
end

--- The game registry as JSON objects (empty `allow` maps stay objects).
local function gamesState(games)
  local out = {}
  for name, g in pairs(games or {}) do
    out[name] = { live = g.live, last = g.last, allow = jsonObject(g.allow), held = jsonObject(g.held or {}),
      process = g.process }
  end
  return out
end

function compute(base, req)
  base = type(base) == "table" and base or {}
  local reloaded = restore(base)
  bindOwners(reloaded)
  resolveOwner(base)
  -- A rebuilt VM republishes once: its owners may read differently now.
  local ownersBefore = reloaded and "" or ownersKey()
  local raw = (req and req.body) or {}
  raw = type(raw) == "table" and raw or {}
  local msg = fields(raw)
  local now = math.tointeger(tonumber(req and (req.timestamp or req.Timestamp)) or 0) or 0
  local slot = tonumber(req and (req.slot or (type(req.body) == "table" and req.body.slot)) or "")
  slot = slot and math.tointeger(slot)
  local action = tostring(msg.Action or "")
  local st = Fair.state
  local changesBefore = st.changes or 0
  local refused = TargetRefusal(raw, req)
  local result
  Fair.gov = type(Fair.gov) == "table" and Fair.gov or {}
  Gov.prune(Gov.queueOf(Fair.gov), now)
  local who = not refused and Gov.ownerOf(base, raw) or nil
  local verb = norm(action)
  -- Every Gov.* (and Fair.Configure) needs the scheduler's time, never
  -- older than the last one seen.
  local late = nil
  if not refused and (verb:sub(1, 4) == "gov." or verb == "fair.configure") then
    local t, why = Gov.clock(now)
    if not t then late = why end
  end
  if refused then
    result = reply(base, { error = refused })
  elseif late then
    result = reply(base, { error = late })
  elseif (who == "dao" and (verb == "fair.configure" or verb == "gov.setdao")) or verb == "gov.apply" or verb == "gov.cancel" then
    local saved, savedOwners = deepCopy(st), deepCopy(GovState)
    local ok, data, outbox, extra = pcall(function()
      if verb == "gov.apply" then return govApply(raw, now) end
      if verb == "gov.cancel" then return govCancel(raw, who) end
      return propose(verb, raw, now)
    end)
    if not ok then
      Fair.state, st = saved, saved
      for k, v in pairs(savedOwners) do GovState[k] = v end
      result = reply(base, { error = tostring(data) })
    elseif data == nil then
      local e = { error = outbox }
      for k, v in pairs(type(extra) == "table" and extra or {}) do e[k] = v end
      result = reply(base, e)
    else
      result = reply(base, data, outbox)
    end
  elseif GOV_VERBS[verb] then
    Gov.handle(base, req)
    base.results.outbox = {}
    result = base
  else
    local function handle()
      local from, fromProcess = actor(raw, base)
      local a = action:lower()
      if norm(a) == "fair.configure" then return configure(raw, Gov.ownerOf(base, raw)) end
      if a == "get-info" then
        local m = fair.pump(st, now)
        return { ok = true }, m and { ["fair-request"] = m } or {}
      end
      local d, o, x = fair.dispatch(st, action, msg, from, fromProcess, now, slot)
      if d == nil and o == nil then return nil, "unknown action '" .. action .. "'" end
      return d, o, x
    end
    -- A handler that failed sends nothing, so it takes no sequence number
    -- and leaves no half-applied state (the beacon's rule). wasm-patch@1.0
    -- has ao.atomic (lua-atomic@1.0's rule: a journal, rolled back on
    -- failure): no copy of the state per message. Elsewhere, a deep copy.
    local ok, data, outbox, extra
    if type(ao) == "table" and type(ao.atomic) == "function" and ao.atomic_version == 1 then
      local r = table.pack(ao.atomic(function()
        local p = table.pack(pcall(handle))
        if not p[1] then return false, tostring(p[2]):sub(1, 4096) end
        return true, table.unpack(p, 2, p.n)
      end))
      ok, data, outbox, extra = r[1], r[2], r[3], r[4]
    else
      local saved = deepCopy(st)
      ok, data, outbox, extra = pcall(handle)
      if not ok then Fair.state, st = saved, saved end
    end
    if not ok then
      result = reply(base, { error = tostring(data) })
    elseif data == nil then
      local e = { error = outbox }
      for k, v in pairs(type(extra) == "table" and extra or {}) do e[k] = v end
      result = reply(base, e)
    else
      result = reply(base, data, outbox)
    end
  end
  -- An owner change is a state change: published at once.
  if ownersKey() ~= ownersBefore then st.changes = (st.changes or 0) + 1 end
  -- Publish only when the state moved (or nothing is published yet): a
  -- refusal or a no-op Get-Info re-encodes nothing.
  if (st.changes or 0) == changesBefore and base.fairstate ~= nil then return result end
  Fair.rev = Fair.rev + 1
  result.fairrev = string.format("%d", Fair.rev)
  -- The whole state: under 5.3b only every CHECKPOINT_EVERY changes, or when
  -- the owners or the queue moved (a restore must never bring back a
  -- renounced wallet or lose a pending action), or when none is published.
  if Lua53bPatchMode ~= true or Fair.rev % CHECKPOINT_EVERY == 0 or base.fairstate == nil
     or ownersKey() ~= ownersBefore then
  result.fairstate = encode({ rev = Fair.rev, owner = Fair.owner, owners = Fair.owners,
    gov = { pending = jsonObject(Fair.gov.pending or {}), nextId = Fair.gov.nextId or 1 }, state = {
    beacon = st.beacon, windowMs = st.windowMs, keep = st.keep, maxOpen = st.maxOpen,
    sessions = jsonObject(st.sessions), byGame = jsonObject(st.byGame), done = jsonObject(st.done),
    open = st.open, next = st.next, batches = jsonObject(st.batches), bound = st.bound,
    outstanding = st.outstanding, attempts = st.attempts, retryAt = st.retryAt,
    minIntervalMs = st.minIntervalMs, maxGames = st.maxGames, maxPerGame = st.maxPerGame,
    games = jsonObject(gamesState(st.games)), gameCount = st.gameCount, lastRequestAt = st.lastRequestAt,
    token = st.token, price = st.price, unit = st.unit, accounts = jsonObject(st.accounts),
    credited = jsonObject(st.credited), creditFloor = st.creditFloor, transferSeq = st.transferSeq,
    surplus = st.surplus, changes = st.changes, history = st.history, doneQueue = st.doneQueue } })
  end
  -- The history only when it moved (a session resolved or a batch bound).
  local h = st.history or {}
  if base.fairhistory == nil or Index.history ~= h[#h] or Index.historyLen ~= #h then
    result.fairhistory = encode({ keep = 1024, entries = h })
    Index.history, Index.historyLen = h[#h], #h
  end
  publishShards(result, st)
  -- Superseded by the shards: a process upgraded from a whole-key build drops them.
  result.fairsessions, result.fairaccounts = nil, nil
  result.fairbatches = encode(fair.batchesView(st))
  result.fairinfo = encode({ beacon = st.beacon, fairWindowMs = st.windowMs, keep = st.keep, maxOpen = st.maxOpen,
    open = st.open, next = st.next, outstanding = st.outstanding, at = now, protocol = "rng/fair/v1",
    minIntervalMs = st.minIntervalMs, maxGames = st.maxGames, maxPerGame = st.maxPerGame, games = st.gameCount,
    token = st.token, requestPriceAtoms = st.price, transferSeq = st.transferSeq,
    requestAfter = st.lastRequestAt and (st.lastRequestAt + st.minIntervalMs) or 0,
    -- gov.lua's owners: { dao, wallet, approved, approvedAt, code, version }.
    gov = Gov.info(), govPending = Gov.pendingView(Gov.queueOf(Fair.gov), now),
    hatch = Gov.hatchOpen(Gov.queueOf(Fair.gov), now), exitFloorMs = Gov.EXIT_FLOOR_MS })
  return result
end
