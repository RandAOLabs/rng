--- sha256.lua -- SHA-256 in pure Lua 5.3, for Luerl.
---
--- Defines the global `Sha256`:
---   Sha256.init()            -> a streaming state
---   Sha256.update(st, s)     -> st, with the bytes of `s` absorbed
---   Sha256.final(st)         -> 64 lowercase hex chars (st is spent)
---   Sha256.hex(s)            -> one-shot digest of `s`
---
--- Every word is masked with `& 0xffffffff`: the words are kept at 32 bits
--- whatever width the host integers wrap at (Luerl or real Lua 5.3).

-- `do`: keep these locals out of the contract this is bundled ahead of.
do
Sha256 = {}

local M32 = 0xffffffff
local K = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

local byte = string.byte
local W = {}

--- Compress the 64 bytes of `s` starting at `at` into `h`.
local function block(h, s, at)
  for j = 0, 15 do
    local a, b, c, d = byte(s, at + 4 * j, at + 4 * j + 3)
    W[j] = (a << 24) | (b << 16) | (c << 8) | d
  end
  for j = 16, 63 do
    local x, y = W[j - 15], W[j - 2]
    local s0 = ((x >> 7) | (x << 25)) ~ ((x >> 18) | (x << 14)) ~ (x >> 3)
    local s1 = ((y >> 17) | (y << 15)) ~ ((y >> 19) | (y << 13)) ~ (y >> 10)
    W[j] = (W[j - 16] + (s0 & M32) + W[j - 7] + (s1 & M32)) & M32
  end
  local a, b, c, d, e, f, g, hh = h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]
  for j = 0, 63 do
    local S1 = (((e >> 6) | (e << 26)) ~ ((e >> 11) | (e << 21)) ~ ((e >> 25) | (e << 7))) & M32
    local ch = (e & f) ~ ((~e) & g & M32)
    local t1 = hh + S1 + ch + K[j + 1] + W[j]
    local S0 = (((a >> 2) | (a << 30)) ~ ((a >> 13) | (a << 19)) ~ ((a >> 22) | (a << 10))) & M32
    local maj = (a & b) ~ (a & c) ~ (b & c)
    hh, g, f, e = g, f, e, (d + t1) & M32
    d, c, b, a = c, b, a, (t1 + S0 + maj) & M32
  end
  h[1] = (h[1] + a) & M32; h[2] = (h[2] + b) & M32
  h[3] = (h[3] + c) & M32; h[4] = (h[4] + d) & M32
  h[5] = (h[5] + e) & M32; h[6] = (h[6] + f) & M32
  h[7] = (h[7] + g) & M32; h[8] = (h[8] + hh) & M32
end

function Sha256.init()
  return {
    h = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
          0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 },
    buf = "", len = 0,
  }
end

function Sha256.update(st, s)
  st.len = st.len + #s
  local i = 1
  if #st.buf > 0 then
    local need = 64 - #st.buf
    if #s < need then st.buf = st.buf .. s; return st end
    block(st.h, st.buf .. string.sub(s, 1, need), 1)
    st.buf, i = "", need + 1
  end
  while i + 63 <= #s do block(st.h, s, i); i = i + 64 end
  st.buf = string.sub(s, i)
  return st
end

function Sha256.final(st)
  local bits = st.len * 8
  local pad = 55 - (st.len % 64)
  if pad < 0 then pad = pad + 64 end
  local tail = { "\128", string.rep("\0", pad) }
  for shift = 56, 0, -8 do tail[#tail + 1] = string.char((bits >> shift) & 0xff) end
  local rest = st.buf .. table.concat(tail)
  for i = 1, #rest, 64 do block(st.h, rest, i) end
  local out = {}
  for i = 1, 8 do out[i] = string.format("%08x", st.h[i]) end
  return table.concat(out)
end

function Sha256.hex(s)
  return Sha256.final(Sha256.update(Sha256.init(), s))
end
end
