// Emits BLS interop vectors for HyperBEAM's vrf@1.0 device from the beacon's own JS (provider/bls.mjs).
// The device's eunit vectors (dev_vrf_test_vectors.erl) were generated with this script.
import { dkgDeal, dkgFinish, partialSign, combine, verify, verifyPartial }
  from '../provider/bls.mjs';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';

const id = 'Xk3_9vQ2mZpL7aRtYw4Hn1cBfGdJs8uEoVq6iT0yK5A'; // 43 chars
if (id.length !== 43) throw new Error('id len');
const msg = `${id}|1`;
const n = 3, t = 2;
const deals = {};
for (let d = 1; d <= n; d++) deals[d] = dkgDeal(n, t);
const commitments = {};
for (const d in deals) commitments[d] = deals[d].commitments;
const members = {};
for (let j = 1; j <= n; j++) {
  const received = {};
  for (const d in deals) received[d] = deals[d].shares[j];
  members[j] = dkgFinish(j, n, received, commitments);
}
const groupKey = members[1].groupKey;
const p1 = partialSign(members[1], msg), p3 = partialSign(members[3], msg);
const groupSig = combine([{ index: 1, signature: p1 }, { index: 3, signature: p3 }]);
const groupSig2 = combine([{ index: 2, signature: partialSign(members[2], `${id}|2`) },
                           { index: 3, signature: partialSign(members[3], `${id}|2`) }]);
if (!verify(groupKey, msg, groupSig)) throw new Error('group verify');
if (!verifyPartial(members[1].publicKey, msg, p1)) throw new Error('partial verify');
if (verify(groupKey, `${id}|2`, groupSig)) throw new Error('wrong msg verified');

const Fp = bls.fields.Fp, Fp2 = bls.fields.Fp2;
const P = Fp.ORDER, half = (P - 1n) / 2n;
const be = (x, len) => x.toString(16).padStart(len * 2, '0');
// An on-curve G1 point outside the r-order subgroup, compressed.
function nonSubgroupG1() {
  for (let x = 1n; ; x++) {
    const rhs = Fp.add(Fp.mul(Fp.mul(x, x), x), 4n);
    let y; try { y = Fp.sqrt(rhs); } catch { continue; }
    if (Fp.mul(y, y) !== rhs) continue;
    const pt = bls.G1.Point.fromAffine({ x, y });
    try { pt.assertValidity(); continue; } catch {}
    const b = Buffer.from(be(x, 48), 'hex'); b[0] |= 0x80; if (y > half) b[0] |= 0x20;
    return b.toString('hex');
  }
}
// An on-curve G2 point outside the r-order subgroup, compressed.
function nonSubgroupG2() {
  const b4 = Fp2.fromBigTuple([4n, 4n]);
  for (let c0 = 1n; ; c0++) {
    const x = Fp2.fromBigTuple([c0, 1n]);
    const rhs = Fp2.add(Fp2.mul(Fp2.mul(x, x), x), b4);
    let y; try { y = Fp2.sqrt(rhs); } catch { continue; }
    if (!Fp2.eql(Fp2.mul(y, y), rhs)) continue;
    const pt = bls.G2.Point.fromAffine({ x, y });
    try { pt.assertValidity(); continue; } catch {}
    const b = Buffer.from(be(x.c1, 48) + be(x.c0, 48), 'hex'); b[0] |= 0x80;
    const sgn = y.c1 !== 0n ? y.c1 > half : y.c0 > half; if (sgn) b[0] |= 0x20;
    return b.toString('hex');
  }
}
const flip = (h, i) => { const b = Buffer.from(h, 'hex'); b[i] ^= 0x01; return b.toString('hex'); };
const corrupted = flip(groupSig, 95);
const inf = (len) => 'c0' + '00'.repeat(len - 1);

const v = (name, pk, m, sig, valid) => ({ name, 'public-key': pk, message: m, signature: sig, valid });
const vectors = [
  v('group-sig', groupKey, msg, groupSig, true),
  v('group-sig-round-2', groupKey, `${id}|2`, groupSig2, true),
  v('single-key-sig', members[1].publicKey, msg, p1, true),
  v('wrong-message', groupKey, `${id}|2`, groupSig, false),
  v('wrong-key', members[2].publicKey, msg, groupSig, false),
  v('partial-under-group-key', groupKey, msg, p1, false),
  v('corrupted-sig', groupKey, msg, corrupted, false),
  v('non-subgroup-sig', groupKey, msg, nonSubgroupG2(), false),
  v('non-subgroup-key', nonSubgroupG1(), msg, groupSig, false),
  v('infinity-key', inf(48), msg, groupSig, false),
  v('infinity-sig', groupKey, msg, inf(96), false),
  v('garbage-sig', groupKey, msg, 'ff'.repeat(96), false),
  v('zero-sig', groupKey, msg, '00'.repeat(96), false),
  v('short-sig', groupKey, msg, groupSig.slice(0, 190), false),
  v('short-key', groupKey.slice(0, 94), msg, groupSig, false),
  v('non-hex-sig', groupKey, msg, 'zz' + groupSig.slice(2), false),
];
// Check every vector against noble too, so both libraries agree.
for (const x of vectors) {
  let ok; try { ok = verify(x['public-key'], x.message, x.signature); } catch { ok = false; }
  if (ok !== x.valid) throw new Error(`noble disagrees on ${x.name}`);
}
console.log(JSON.stringify(vectors, null, 1));
