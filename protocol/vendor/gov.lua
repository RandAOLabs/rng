--- gov.lua -- two equal owners and code upgrade, shared by every governed
--- lua-patch@1.0 contract. Load AFTER sha256.lua, which defines `Sha256`.
---
--- OWNERS. A governed process has two:
---   * the WALLET: the launch wallet (the spawn/bootstrap owner), until it
---     sends Gov.Renounce-Wallet;
---   * the DAO: a process (`GovState.dao`, "" until Gov.Set-Dao), whose passed
---     proposal arrives as a push from that process, signed by THIS process's
---     scheduler. A passed proposal is one tags-only message and takes effect
---     on receipt.
--- Identity comes only from the raw body's `commitments`: exactly one RSA-PSS
--- committer (algorithm read from `type` OR `alg`), no other non-hmac
--- committer beside it. Never a tag, never an hmac.
---
--- VERBS (dispatch compares names with case, `-` and `_` folded):
---   Gov.Set-Dao        Dao=<43-char pid>       owner (wallet or DAO)
---   Gov.Renounce-Wallet                        wallet only, one way; refused
---                                              while no DAO is set
---   Gov.Approve-Code   Code-Root=<64 hex>      owner; latest approval wins
---   Gov.Upgrade        Data=<code>             one message, see below
---   Gov.Upgrade        Part=0 Data=<manifest>  starts a chunked upload
---   Gov.Upgrade        Part=i Data=<part i>    i = 1..n, any order
---
--- CODE ROOT. Code is split into n parts of at most Gov.PART_MAX bytes. The
--- hash costs ~9.5 us a byte in Luerl, and anyone may send a part (or one
--- message of code) that is hashed before it can be refused, so a part is
--- kept to ~150 ms of one slot: about what any message costs. The
--- MANIFEST is the lowercase hex sha256 of each part, in order, joined by
--- newlines (no trailing one); the ROOT is sha256(manifest). One message of
--- code is one part, so its root is sha256(hex(sha256(code))) (`Gov.rootOf`).
--- backend/native/gov-upgrade.mjs prints a bundle's root and sends it.
---
--- ONE MESSAGE (no Part tag): from an owner at most Gov.MAX_CODE bytes, from
--- anyone else at most Gov.PART_MAX. The owner WALLET installs it directly;
--- anyone else only when its root is the approved one.
---
--- An approval is valid only against the code that was live when it was
--- given: ANY successful install spends it, whoever sent the code. Code whose
--- root is the one running is already installed and changes nothing.
---
--- CHUNKED (anyone, for the approved root; nothing a stranger sends can
--- reset, block or replace an upload, because every byte kept is pinned by
--- the root an owner approved):
---   * Part=0: the manifest, 1..Gov.MAX_CODE/Gov.PART_MAX lines. Taken when
---     sha256(manifest) is the approved root; again with the same root it
---     changes nothing. An OWNER's manifest for another root approves that
---     root first (it is Approve-Code plus the manifest in one message).
---   * Part=i: kept by index when sha256(Data) is manifest line i; a part
---     already held changes nothing, a wrong part is refused unchanged.
---   * When all n are held they are joined and installed; the parts are
---     dropped either way, and a successful install spends the approval.
--- The upload lives in the heap global `GovUpload` (never checkpointed: a
--- rebuilt VM starts it again), and only while its root is the approved one:
--- a new approval drops it. Memory is bounded by Gov.MAX_CODE.
---
--- INSTALL runs the code as a chunk with every global BINDING saved first. A
--- load or runtime error puts those bindings back and replies ok=false. It
--- does not undo a change made INSIDE a table the new code reached, so the
--- bundle's top level and UpgradeMigrate must never mutate existing state in
--- place: build new tables and assign them to globals (an assignment is
--- undone with the rest), or keep the top level to `X = X or {}`. On success
--- the new
--- code's `X = X or {}` globals keep their state, provided it defined a new
--- `compute` (and, on a lua-patch process, re-ran lua53b.lua -- anything else
--- would leave every later message failing, Gov.* included), and `Lua53bBootstrapBase`,
--- `Owner`, `GovState` and every name in `Gov.KEEP` are put back as they were,
--- then a global `UpgradeMigrate()` (if the new code defines one) runs under
--- pcall and is cleared; its failure also puts the old bindings back. It must
--- be idempotent: a rebuilt VM reinstalls the same code over state it already
--- migrated (see COLD RESTORE). The code
--- must be a full lua-patch bundle (it redefines `compute`) and must not call
--- collectgarbage at top level: on Luerl a collect inside pcall kills the VM.
---
--- INTEGRATION (a contract's compute, AFTER its target door):
---
---   if Gov.handle(base, req) then return base end
---
--- and replace its owner check with `Gov.isOwner(base, req)` (or
--- `Gov.ownerOf(base, msg)` where only the body is at hand). Hooks a contract
--- may set after loading this file:
---   Gov.walletOwner(base) -> address   default: global `Owner`, else the
---                                      process definition's RSA committer
---   Gov.reply(base, t)                 default: base.results = {output={data=json}}
---   Gov.changed(base)                  after any owner/code change: republish
---                                      the info key that folds in Gov.info()
---   Gov.KEEP = { "Name", ... }         more globals an upgrade must not reset:
---                                      every spawn-time or runtime-sealed
---                                      config a bundle assigns outright
---
--- COLD RESTORE. `GovState` lives only in the VM. A contract's restore path
--- calls `Gov.restore(published, field[, rebuilt])` with its own info key (raw
--- or decoded) and the name `Gov.info()` sits under in it, so a rebuilt VM gets
--- its owners back instead of the defaults (which would re-arm a renounced
--- wallet and drop the DAO). `rebuilt` says the VM has run before: then a
--- missing or unreadable info key means its owners are unknown, and it has
--- none. Installed code lived in the old heap and the rebuilt VM runs the
--- spawn module, so the code root it ran comes back APPROVED, not installed:
--- anyone can resend the same bytes, and until then `code` reads "".

-- `do`: bundlers concatenate this ahead of the contract, so a top-level local
-- here would shadow the contract's own (`encode`, `int`) and count against
-- its 200-local limit. Only the globals `Gov` and `GovState` leave this block.
do
Gov = {}
GovState = GovState or { dao = "", wallet = true, approved = "", code = { sha = "", version = 0 } }

Gov.PART_MAX = 16 * 1024
Gov.MAX_CODE = 2 * 1024 * 1024

local SIG = { ["rsa-pss-sha512"] = true, ["rsa-pss-sha256"] = true }

local function validId(v)
  return type(v) == "string" and #v == 43 and string.find(v, "^[A-Za-z0-9_-]+$") ~= nil
end

local function key(name)
  return (string.gsub(string.lower(tostring(name)), "[-_]", ""))
end

--- A tag's value by folded name; two spellings with different values is none.
local function tag(msg, name)
  local want, found = key(name), nil
  for k, v in pairs(msg) do
    if type(k) == "string" and key(k) == want then
      if found ~= nil and found ~= v then return nil end
      found = v
    end
  end
  return found
end

local function int(v)
  if type(v) == "number" then return math.tointeger(v) end
  if type(v) == "string" and string.find(v, "^%d+$") and #v <= 15 then
    return math.tointeger(tonumber(v))
  end
  return nil
end

--- The one RSA-PSS committer of a body's commitments, or nil.
function Gov.signerOf(msg)
  local c = type(msg) == "table" and msg.commitments or nil
  if type(c) ~= "table" then return nil end
  local found, rsa, mixed = nil, false, false
  for _, s in pairs(c) do
    if type(s) == "table" and s.committer ~= nil then
      local alg = s.type or s.alg
      local hmac = type(alg) == "string" and string.sub(alg, 1, 4) == "hmac"
      if not hmac then
        if found ~= nil and found ~= s.committer then mixed = true end
        found = s.committer
        if SIG[alg] then rsa = true else mixed = true end
      end
    end
  end
  if mixed or not rsa or type(found) ~= "string" then return nil end
  return found
end

function Gov.provenSigner(req)
  return Gov.signerOf(type(req) == "table" and req.body or nil)
end

--- This process's own scheduler.
function Gov.scheduler(base)
  if type(base) ~= "table" then return nil end
  local found = base["scheduler-location"]
  if validId(found) then return found end
  local p = base.process
  if type(p) == "table" and validId(p["scheduler-location"]) then return p["scheduler-location"] end
  return nil
end

function Gov.walletOwner(base)
  if validId(Owner) then return Owner end
  local p = type(base) == "table" and base.process or nil
  return Gov.signerOf(type(p) == "table" and p or nil)
end

--- 'wallet', 'dao' or nil, for a message body.
function Gov.ownerOf(base, msg)
  if type(msg) ~= "table" then return nil end
  local signer = Gov.signerOf(msg)
  if not signer then return nil end
  local from = msg["from-process"]
  if from ~= nil and signer == Gov.scheduler(base) then
    -- A scheduler-attested process delivery: only the DAO is an owner here.
    if GovState.dao ~= "" and from == GovState.dao then return "dao" end
    return nil
  end
  if GovState.wallet and signer == Gov.walletOwner(base) then return "wallet" end
  return nil
end

function Gov.isOwner(base, req)
  return Gov.ownerOf(base, type(req) == "table" and req.body or nil)
end

function Gov.info()
  return {
    dao = GovState.dao, wallet = GovState.wallet == true, approved = GovState.approved,
    code = GovState.code.sha, version = GovState.code.version,
  }
end

local function isHex64(v)
  return type(v) == "string" and #v == 64 and string.find(v, "^[0-9a-f]+$") ~= nil
end

--- Adopt the published gov state, once per VM (`GovState.checked`, which a
--- rebuilt VM no longer has), and only into a GovState still at its fresh
--- default. Never turns the wallet back on.
function Gov.restore(published, field, rebuilt)
  if GovState.checked then return end
  GovState.checked = true
  local s = GovState
  if s.dao ~= "" or not s.wallet or s.approved ~= "" or s.code.sha ~= ""
      or (int(s.code.version) or 0) ~= 0 then return end
  local info = published
  if type(info) == "string" then
    local json = package.loaded[".json"]
    local ok, v = pcall(json.decode, info)
    info = ok and v or nil
  end
  info = type(info) == "table" and info[field] or nil
  if type(info) ~= "table" then
    -- A VM that has run before and cannot read its owners has none.
    if rebuilt then s.wallet = false end
    return
  end
  local approved = isHex64(info.approved) and info.approved or ""
  if approved == "" and isHex64(info.code) then approved = info.code end
  GovState = {
    dao = validId(info.dao) and info.dao or "", wallet = s.wallet and info.wallet ~= false,
    approved = approved, code = { sha = "", version = int(info.version) or 0 }, checked = true,
  }
end

local function encode(t)
  local keys = {}
  for k in pairs(t) do keys[#keys + 1] = k end
  table.sort(keys)
  local out = {}
  for _, k in ipairs(keys) do
    local v = t[k]
    if type(v) == "string" then
      v = '"' .. string.gsub(v, '[%c"\\]', function(c)
        if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" end
        return string.format("\\u%04x", string.byte(c))
      end) .. '"'
    elseif type(v) == "number" then v = string.format("%d", v)
    else v = tostring(v) end
    out[#out + 1] = '"' .. k .. '":' .. v
  end
  return "{" .. table.concat(out, ",") .. "}"
end

function Gov.reply(base, t)
  base.results = { output = { data = encode(t) } }
end

function Gov.changed(base) end
Gov.DEFAULT = { reply = Gov.reply, changed = Gov.changed }

Gov.KEEP = {}

--- Run `code` as the process's new code. Returns true or false, error.
function Gov.install(code, root)
  local chunk, err = load(code, "=gov-upgrade", "t")
  if not chunk then return false, "load: " .. tostring(err) end
  local saved = {}
  for k, v in pairs(_G) do saved[k] = v end
  local keep = { "Lua53bBootstrapBase", "Owner", "GovState" }
  for _, k in ipairs(Gov.KEEP) do keep[#keep + 1] = k end
  local ok, e = pcall(chunk)
  -- The new code must be able to answer the next message, Gov.Upgrade
  -- included: its own compute, and on a lua-patch process a fresh lua53b.lua
  -- adapter around it (a 5.3a bundle would leave the 5.3b device calling the
  -- 5.3a entry point with one argument). lua53b.lua binds a new
  -- Lua53bRequestSlot closure each time it runs.
  if ok and (type(compute) ~= "function" or compute == saved.compute
      or (saved.Lua53bRequestSlot ~= nil and Lua53bRequestSlot == saved.Lua53bRequestSlot)) then
    ok, e = false, "the code must be a full bundle for this process (a new compute"
      .. (saved.Lua53bRequestSlot ~= nil and " wrapped by lua53b.lua)" or ")")
  end
  if ok then
    for _, k in ipairs(keep) do _G[k] = saved[k] end
    local migrate = UpgradeMigrate
    UpgradeMigrate = nil
    if type(migrate) == "function" then ok, e = pcall(migrate) end
  end
  if not ok then
    local added = {}
    for k in pairs(_G) do if saved[k] == nil then added[#added + 1] = k end end
    for _, k in ipairs(added) do _G[k] = nil end
    for k, v in pairs(saved) do _G[k] = v end
    return false, tostring(e)
  end
  GovState.code = { sha = root, version = (int(GovState.code.version) or 0) + 1 }
  return true
end

--- The root of one message of code: its manifest is one line.
function Gov.rootOf(code)
  return Sha256.hex(Sha256.hex(code))
end

local function current(root)
  return { ok = true, installed = root, version = GovState.code.version, current = true }
end

--- Install; success spends any approval and any upload. Returns the reply.
local function installRoot(code, root)
  local ok, err = Gov.install(code, root)
  if not ok then return { ok = false, error = err, root = root } end
  GovState.approved = ""; GovUpload = nil
  return { ok = true, installed = root, version = GovState.code.version }
end

--- Returns the reply and whether owners/code changed.
local function upgrade(base, msg, who)
  if not Gov.signerOf(msg) then return { ok = false, error = "Not signed" } end
  local data = msg.data or msg.Data or msg.body
  if type(data) ~= "string" or data == "" then return { ok = false, error = "No code" } end
  local partTag = tag(msg, "Part")
  local approved = GovState.approved

  if partTag == nil then
    if who ~= "wallet" and approved == "" then return { ok = false, error = "No approved code" } end
    if #data > (who and Gov.MAX_CODE or Gov.PART_MAX) then
      return { ok = false, error = "Code too large for one message; send it in parts" }
    end
    local root = Gov.rootOf(data)
    if root == GovState.code.sha then return current(root) end
    if who ~= "wallet" and root ~= approved then
      return { ok = false, error = "Code does not match the approved root", root = root }
    end
    local out = installRoot(data, root)
    return out, out.ok
  end

  local part = int(partTag)
  if not part then return { ok = false, error = "Part must be a whole number" } end

  if part == 0 then
    local maxParts = Gov.MAX_CODE // Gov.PART_MAX
    if who == nil and approved == "" then return { ok = false, error = "No approved code" } end
    if #data > maxParts * 65 - 1 then return { ok = false, error = "Manifest too large" } end
    -- Fixed width, 64 hex and a newline between lines (gmatch with an empty
    -- match kills the Luerl VM).
    local hashes, n = {}, (#data + 1) // 65
    if (#data + 1) % 65 ~= 0 then hashes = nil end
    for i = 1, hashes and n or 0 do
      local line = string.sub(data, (i - 1) * 65 + 1, i * 65 - 1)
      if not isHex64(line) or (i < n and string.sub(data, i * 65, i * 65) ~= "\n") then hashes = nil; break end
      hashes[i] = line
    end
    if not hashes or #hashes < 1 or #hashes > maxParts then
      return { ok = false, error = "Manifest must be 1.." .. maxParts .. " lines of 64 lowercase hex" }
    end
    local root = Sha256.hex(data)
    if root == GovState.code.sha then return current(root) end
    local u = GovUpload
    if root == approved and type(u) == "table" and u.root == root then
      return { ok = true, part = 0, parts = u.n, have = u.have, root = root }
    end
    local changed = false
    if root ~= approved then
      if who == nil then
        return { ok = false, error = "Manifest does not match the approved root", root = root }
      end
      GovState.approved, changed = root, true
    end
    GovUpload = { root = root, hashes = hashes, n = #hashes, parts = {}, have = 0 }
    return { ok = true, part = 0, parts = #hashes, have = 0, root = root,
      approved = changed and root or nil }, changed
  end

  local u = GovUpload
  if type(u) ~= "table" or approved == "" or u.root ~= approved then
    return { ok = false, error = "No upload in progress; send the manifest as Part=0" }
  end
  if part < 1 or part > u.n then return { ok = false, error = "Part must be 0.." .. u.n } end
  if u.parts[part] then return { ok = true, part = part, parts = u.n, have = u.have } end
  if #data > Gov.PART_MAX then return { ok = false, error = "Part too large" } end
  local sha = Sha256.hex(data)
  if sha ~= u.hashes[part] then
    return { ok = false, error = "Part does not match the manifest", part = part, sha = sha }
  end
  u.parts[part], u.have = data, u.have + 1
  if u.have < u.n then return { ok = true, part = part, parts = u.n, have = u.have } end
  GovUpload = nil
  local out = installRoot(table.concat(u.parts), u.root)
  return out, out.ok
end

--- Handle a Gov.* message. True when it was one (the reply is set).
function Gov.handle(base, req)
  local msg = type(req) == "table" and req.body or nil
  if type(msg) ~= "table" then return false end
  local action = tag(msg, "Action")
  if type(action) ~= "string" or string.sub(key(action), 1, 4) ~= "gov." then return false end
  action = key(action)
  local who = Gov.ownerOf(base, msg)
  -- An install re-runs this file, so `Gov` is then a new table. Its hooks
  -- are the new code's when that code set them at load, and otherwise (a
  -- contract that binds them per slot) the old code's finish the slot.
  local old = Gov
  local out, dirty
  if action == "gov.setdao" then
    local dao = tag(msg, "Dao")
    if not who then out = { ok = false, error = "Not authorised" }
    elseif not validId(dao) then out = { ok = false, error = "Dao must be a 43-character process id" }
    else GovState.dao = dao; out = { ok = true, dao = dao } end
    dirty = out.ok
  elseif action == "gov.renouncewallet" then
    if who ~= "wallet" then out = { ok = false, error = "Not authorised" }
    elseif GovState.dao == "" then out = { ok = false, error = "Set a DAO first" }
    else GovState.wallet = false; out = { ok = true, wallet = false } end
    dirty = out.ok
  elseif action == "gov.approvecode" then
    local root = tag(msg, "Code-Root")
    if not who then out = { ok = false, error = "Not authorised" }
    elseif not isHex64(root) then
      out = { ok = false, error = "Code-Root must be 64 lowercase hex" }
    else
      if root ~= GovState.approved then GovUpload = nil end
      GovState.approved = root; out = { ok = true, approved = root }
    end
    dirty = out.ok
  elseif action == "gov.upgrade" then
    out, dirty = upgrade(base, msg, who)
  else
    out = { ok = false, error = "Unknown Gov action" }
  end
  local function hook(name)
    local new = Gov[name]
    if Gov ~= old and type(Gov.DEFAULT) == "table" and new ~= Gov.DEFAULT[name] then return new end
    return old[name]
  end
  hook("reply")(base, out)
  if dirty then hook("changed")(base) end
  return true
end
end
