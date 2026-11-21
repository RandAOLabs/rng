--- slot_bench.lua -- what one slot costs a protocol process (the fast tier or
--- fair) holding a given published state, in Luerl, on a live node
--- (protocol/test/bench-slot.mjs). Free, unsigned.
---
--- The state is a snapshot of a live process's own published keys (`Seed`),
--- handed in the way each device hands it: mode "a" as the `base` lua@5.3a
--- passes every slot, mode "b" as the lua-patch@1.0 adapter's published shadow.
--- Slot 1 restores the contract from it; the timed slots are `Get-Info` from a
--- stranger (the cheapest message each of them answers, and one that still
--- publishes: the fast tier republishes its whole state every slot).
---
--- Bundle: the contract (either mode), `Seed = { ... }`, this file, then
--- `return slotbench(<mode>, <slots>)`.

function slotbench(mode, slots)
  local SELF = "SELFprocesspppppppppppppppppppppppppppppppp"
  local OWNER = "OWNERoooooooooooooooooooooooooooooooooooooo"
  local SCHED = "SCHEDulerrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
  local STRANGER = "STRANGERsssssssssssssssssssssssssssssssssss"
  Owner = nil
  local base = { ["scheduler-location"] = SCHED,
    process = { commitments = { p = { type = "rsa-pss-sha512", committer = OWNER } } } }
  for k, v in pairs(Seed) do
    if mode == "a" then base[k] = v else Lua53bPublishedState[k] = v end
  end
  local slot = 0
  local function call()
    slot = slot + 1
    local body = { target = SELF, Action = "Get-Info", commitments = { s = { committer = STRANGER,
      alg = "rsa-pss-sha512", committed = { "target", "action" } } } }
    local req = { process = SELF, slot = slot, body = body, timestamp = 1800000000000 + slot }
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

  call() -- restore from the seed
  local start, last, before = os.clock(), nil, nil
  for i = 1, slots do
    if i == slots then
      before = {}
      for k, v in pairs(published()) do if type(v) == "string" then before[k] = v end end
      start = start - os.clock()
    end
    last = call()
    if i == slots then start = start + os.clock() end
  end
  local per = (os.clock() - start) / slots

  local keys, bytes = 0, 0
  for _, value in pairs(published()) do
    if type(value) == "string" then keys = keys + 1; bytes = bytes + #value end
  end
  local patched, patchBytes = 0, 0
  if mode == "a" then
    for k, v in pairs(base) do
      if type(v) == "string" and before[k] ~= v then patched = patched + 1; patchBytes = patchBytes + #v end
    end
  else
    for _, p in ipairs(last.patches or {}) do patched = patched + 1; patchBytes = patchBytes + #(p.value or "") end
  end
  return string.format(
    "mode %s  slots %d  lua %.1f ms/slot  published %d keys %d bytes  last slot %d keys %d bytes  reply %s",
    mode, slots, per * 1000, keys, bytes, patched, patchBytes,
    tostring(last.results and last.results.output and last.results.output.data):sub(1, 60))
end
