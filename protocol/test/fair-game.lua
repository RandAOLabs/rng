-- Minimal AO process for the live smoke test (deploy/smoke.mjs, scenario E):
-- a game process using the fair-play process. From its owner: `Open
-- { Session, Player }` sends Fair.Open, `Withdraw { Nonce }` sends
-- Fair.Withdraw (the free balance comes back to this process). Records each
-- Fair-Result our scheduler attests comes from the fair process. Publishes
-- `gamestate`.
local json = require(".json")

Game = Game or { opened = 0, results = {}, rejected = 0 }

local function restore(base)
  local ok, saved = pcall(json.decode, base and base.gamestate or "")
  if ok and type(saved) == "table" then Game = saved end
  Game.results = type(Game.results) == "table" and Game.results or {}
end

local function field(msg, name)
  for key, value in pairs(msg) do
    if tostring(key):lower() == name:lower() then return value end
  end
  if type(msg.Tags) == "table" then
    for key, value in pairs(msg.Tags) do
      if tostring(key):lower() == name:lower() then return value end
    end
  end
  return nil
end

local function signedBy(msg, who)
  local c = msg.commitments or msg.Commitments
  if type(c) ~= "table" then return false end
  for _, s in pairs(c) do
    if type(s) == "table" and s.committer == who then return true end
  end
  return false
end

function compute(base, req)
  base = type(base) == "table" and base or {}
  restore(base)
  local msg = req and req.body or {}
  local outbox = {}
  local action = field(msg, "Action")
  local from = field(msg, "from-process")
  local owner = not from and signedBy(msg, "__OWNER__")
  if action == "Open" and owner then
    outbox.open = { target = "__FAIR__", Action = "Fair.Open", Session = field(msg, "Session"), Player = field(msg, "Player") }
    Game.opened = (tonumber(Game.opened) or 0) + 1
  elseif action == "Withdraw" and owner then
    outbox.withdraw = { target = "__FAIR__", Action = "Fair.Withdraw", Nonce = field(msg, "Nonce") }
  elseif action == "Fair-Result" then
    if from ~= "__FAIR__" or not signedBy(msg, "__SCHEDULER__") then
      Game.rejected = (tonumber(Game.rejected) or 0) + 1
    else
      local session = field(msg, "Session")
      if type(session) == "string" then
        Game.results[session] = { status = field(msg, "Status"), final = field(msg, "Final"), round = field(msg, "Round") }
      end
    end
  end
  base.results = { output = { data = json.encode(Game) }, outbox = outbox }
  base.gamestate = json.encode(Game)
  return base
end
