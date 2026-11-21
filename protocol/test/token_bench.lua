--- token_bench.lua -- what one Transfer slot costs the RNG token holding
--- HOLDERS balances, in Luerl, on a live node (protocol/test/bench-token.mjs).
--- Free, unsigned. Paralith-mono's products/rugless/contracts/token_bench.lua,
--- for this token.
---
--- mode "b": the lua-patch@1.0 bundle, driven the way the device does, through
---   the adapter's one-argument `compute(request)`; it reports the patches of
---   the last slot and the published shadow (Lua53bPublishedState).
--- mode "a": the bare contract, driven the way lua@5.3a does, `compute(base,
---   req)` with the whole published map handed back every slot; the node's own
---   encode/decode of that map is NOT in this figure, only the Lua.
---
--- The holders are minted at genesis, so whatever the build publishes per
--- holder is published here too. Lua time is os.clock, which on Luerl is the
--- node's CPU clock: compare runs on one node, and trust bench-token.mjs's wall
--- difference first.
---
--- Bundle: the token (either mode), then this file, then
--- `return tokenbench(<mode>, <holders>, <transfers>)`.

function tokenbench(mode, holders, transfers)
  local SELF = "SELFtokentttttttttttttttttttttttttttttttttt"
  local OWNER = "OWNERoooooooooooooooooooooooooooooooooooooo"
  local SCHED = "SCHEDulerrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
  local ALICE = "ALICEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  local SUPPLY = 1000000000000000

  -- 64 symbols spread the holders over every balance bucket (the first four
  -- bytes pick it), the way real addresses do.
  local A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  local function address(i)
    local h, out = (i * 2654435761) % 16777216, {}
    for d = 1, 4 do
      local n = h % 64
      out[d] = A:sub(n + 1, n + 1)
      h = (h - n) // 64
    end
    return table.concat(out) .. string.format("%039d", i)
  end

  local each = 1000
  local alloc = { [ALICE] = SUPPLY - holders * each }
  for i = 1, holders do alloc[address(i)] = each end
  GenesisAllocations = alloc

  local base = { ["scheduler-location"] = SCHED,
    process = { commitments = { p = { type = "rsa-pss-sha512", committer = OWNER } } } }
  local slot = 0
  local function call(who, tags)
    slot = slot + 1
    local body = { target = SELF, commitments = { s = { committer = who, alg = "rsa-pss-sha512",
      committed = { "target", "action", "recipient", "quantity" } } } }
    for k, v in pairs(tags) do body[k] = v end
    local req = { process = SELF, slot = slot, body = body, timestamp = 1700000000000 + slot }
    if mode == "a" then
      base = compute(base, req)
      return base
    end
    local r = compute(req)
    -- lua-patch@1.0 collects the heap itself, periodically; this endpoint's
    -- collectgarbage("step") does nothing, so the heap would only grow. One
    -- full collect per slot instead (an upper bound), unless BenchNoCollect.
    if not BenchNoCollect then collectgarbage("collect") end
    return r
  end
  local function published()
    return mode == "a" and base or Lua53bPublishedState
  end

  call(ALICE, { Action = "Info" }) -- genesis: every holder minted
  call(ALICE, { Action = "Transfer", Recipient = address(1), Quantity = "1" })

  local start = os.clock()
  local last, before
  for i = 1, transfers do
    if i == transfers then
      before = {}
      for k, v in pairs(published()) do if type(v) == "string" then before[k] = v end end
      start = start - os.clock() -- the snapshot is not the token's cost
    end
    last = call(ALICE, { Action = "Transfer", Recipient = address(i * 7 % holders + 1), Quantity = "1" })
    if i == transfers then start = start + os.clock() end
  end
  local per = (os.clock() - start) / transfers

  local keys, bytes, holderKeys = 0, 0, 0
  for key, value in pairs(published()) do
    if type(value) == "string" then
      keys = keys + 1
      bytes = bytes + #value
      if key:sub(1, 8) == "balance-" then holderKeys = holderKeys + 1 end
    end
  end
  -- What the last slot wrote: its patches (b), or the keys whose value moved (a).
  local patched, patchBytes = 0, 0
  if mode == "a" then
    for k, v in pairs(base) do
      if type(v) == "string" and before[k] ~= v then patched = patched + 1; patchBytes = patchBytes + #v end
    end
  else
    for _, p in ipairs(last.patches or {}) do patched = patched + 1; patchBytes = patchBytes + #(p.value or "") end
  end
  local results = last.results
  return string.format(
    "mode %s  holders %d  transfers %d  lua %.1f ms/transfer  published %d keys (%d balance-) %d bytes  last slot %d keys %d bytes  reply %s",
    mode, holders, transfers, per * 1000, keys, holderKeys, bytes, patched, patchBytes,
    tostring(results and results.output and results.output.data):sub(1, 60))
end
