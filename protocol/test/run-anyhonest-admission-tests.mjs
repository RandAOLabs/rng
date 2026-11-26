// Signed fixtures use ephemeral local keys with native Lua credit accounting.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import AoLoader from '@permaweb/ao-loader';

const root = new URL('../../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('base64url');
const actor = () => {
  const keys = crypto.generateKeyPairSync("ed25519");
  const rawPublic = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { ...keys, address: hash(rawPublic) };
};
const rng = actor(), main = actor(), wallet = actor();
const identity = role => hash("local-test/" + role);
const beacon = identity("any-honest");
const shard = identity("shard");
const token = identity("token");
const validators = [identity("validator-one"), identity("validator-two")];
const entry = identity("request-outbox-entry");

function sign(actor, value) {
  const body = Buffer.from(JSON.stringify(value));
  return { body, signature: crypto.sign(null, body, actor.privateKey) };
}
function authenticated(actor, packet) {
  assert(crypto.verify(null, packet.body, actor.publicKey, packet.signature));
  return JSON.parse(packet.body);
}
assert.throws(() => authenticated(rng, sign(main, { process: beacon })));
let nextSlot = 0;
function assignment(source, body, admit = undefined) {
  const signed = sign(source, { target: beacon, ...body });
  const id = hash(signed.body);
  const result = authenticated(rng, sign(rng, {
    process: beacon, slot: ++nextSlot, timestamp: 1700000000000 + nextSlot * 10,
    bodyId: id, ...admit,
  }));
  assert.equal(result.bodyId, id);
  assert.equal(result.process, beacon);
  return { ...result, body: { ...authenticated(source, signed),
    commitments: { actor: { type: "ed25519-sha512", committer: source.address,
      committed: ["target", "data", "action"] } },
  } };
}
const credit = (to, amount, ordinal, request) => assignment(rng, {
  Action: "Credit-Notice", "from-process": token, Sender: wallet.address,
  Quantity: String(amount * 1_000_000), Reference: "t" + ordinal,
  ...(to ? { "X-For": to } : {}), ...(request ? { "X-Request-Id": request } : {}),
});
const req = id => ({ Action: "Request-Random", Tier: "any-honest", "Request-Id": id });
const foreign = id => ({ ...req(id), "from-process": shard, "from-slot": 3, "from-entry": entry });
const matching = { "admit-process": shard, "admit-slot": 3, "admit-entry": entry };
const inputs = {
  rngScheduler: rng.address, mainScheduler: main.address, wallet: wallet.address,
  shard, token, beacon, validators,
  credits: [credit(undefined, 8, 1), credit(shard, 8, 2), credit(main.address, 24, 3)],
  requests: [
    { kind: "wallet", assignment: assignment(wallet, req("wallet1")) },
    { kind: "admitted", assignment: assignment(main, foreign("shard1"), matching) },
    { kind: "bareForeign", assignment: assignment(main, foreign("bare1")) },
    { kind: "mismatch", assignment: assignment(main, foreign("mismatch1"), { ...matching, "admit-slot": 4 }) },
    { kind: "wrongOrigin", assignment: assignment(main, foreign("wrong-origin1"), { ...matching, "admit-process": identity("other-shard") }) },
    { kind: "partialLocal", assignment: assignment(rng, foreign("partial1"), { "admit-entry": entry }) },
    { kind: "combined", assignment: credit(undefined, 4, 4, "combined1") },
  ],
};
const original = process.env.ANYHONEST_BASELINE;
const source = original ? fs.readFileSync(original, "utf8") : read("protocol/beacon/anyhonest.lua");
const bundle = [
  read("protocol/vendor/json.lua"),
  'local jsonx = (function()', read("protocol/vendor/jsonenc.lua"), 'end)()',
  'encode, jsonObject = jsonx.encode, jsonx.object',
  'json = require(".json")',
  'Owner, TestHarness = nil, false',
  'rng = (function()', read("lib/rng.lua"), 'end)()',
  read("protocol/vendor/sha256.lua"), read("protocol/vendor/gov.lua"), source,
  'SignedAdmissionFixture = ' + JSON.stringify(JSON.stringify(inputs)),
  read("protocol/test/anyhonest-admission-test.lua"),
].join("\n");
const wasm = fs.readFileSync(process.env.AOS_WASM || "C:/REPO/paralith-mono/backend/native/module/AOS.wasm");
const handle = await AoLoader(wasm, {
  format: "wasm32-unknown-emscripten", computeLimit: 9_000_000_000_000, memoryLimit: 512 * 1024 * 1024,
});
const localOwner = identity("eval-owner");
const out = await handle(null, {
  Id: "local-anyhonest-admission-test", Target: beacon, Owner: localOwner, From: localOwner,
  Tags: [{ name: "Action", value: "Eval" }], Data: bundle,
  "Block-Height": "1", Timestamp: "1700000000000",
  Module: "local-anyhonest-module".padEnd(43, "_"), Cron: false,
}, { Process: { Id: beacon, Owner: localOwner, Tags: [
  { name: "Data-Protocol", value: "ao" }, { name: "Variant", value: "ao.TN.1" }, { name: "Type", value: "Process" },
] } });
if (out.Error) throw Error(out.Error);
const data = out.Output?.data;
const result = JSON.parse(typeof data === "string" ? data : data?.output);
assert.deepEqual(result.wallet.pending.wallet1, { payer: wallet.address, process: false });
assert.equal(result.wallet.wallet, 4);
assert.deepEqual(result.combined.pending.combined1, { payer: wallet.address, process: false });
assert.equal(result.combined.wallet, 4);
if (original) {
  assert.deepEqual(result.admitted.pending.shard1, { payer: main.address, process: false });
  assert.equal(result.admitted.scheduler, 20);
  assert.equal(result.admitted.shard, 8);
} else {
  assert.deepEqual(result.admitted.pending.shard1, { payer: shard, process: true });
  assert.equal(result.admitted.scheduler, 24);
  assert.equal(result.admitted.shard, 4);
  for (const k of ["bareForeign", "mismatch", "wrongOrigin", "partialLocal"]) {
    assert.equal(result[k].reply.error, "Unsigned");
    assert.equal(result[k].scheduler, 24);
    assert.equal(result[k].shard, 4);
  }
}
const entryOwner = result.admitted.pending.shard1.payer === shard ? "shard" : "scheduler-wallet";
console.log(JSON.stringify({ case: original ? "before" : "after", wallet: result.wallet.wallet,
  combined: result.combined.wallet, admittedPayer: entryOwner,
  admittedProcessReply: result.admitted.pending.shard1.process,
  afterAdmitted: { shard: result.admitted.shard, schedulerWallet: result.admitted.scheduler },
  wrongAdmission: Object.fromEntries(["bareForeign", "mismatch", "wrongOrigin", "partialLocal"]
    .map(kind => [kind, result[kind].reply.error ?? "accepted"])),
}));
