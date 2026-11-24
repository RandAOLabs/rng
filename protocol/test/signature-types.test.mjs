// The signature types that name a signer, defined ONCE here and checked in
// every contract. A spawned module is one Lua chunk and cannot `require`, so
// each contract (and each copy of the target door) carries its own table; a
// table that drifts is a contract that refuses a real signature, or believes a
// commitment that names whoever it claims. Every table literal that lists
// `rsa-pss-sha512` must list exactly these.
//
//   rsa-pss-sha512  a wallet's HTTP message signature
//   rsa-pss-sha256  an ANS-104 / Arweave RSA item (wallets, an RSA scheduler)
//   ed25519-sha512  an ANS-104 Ed25519 item: a node's Ed25519 scheduling key
//                   (HyperBEAM `scheduler-key-type`), its assignments and pushes
//
// hmac-sha256 is never one: an hmac names whoever it claims to (CLAUDE.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SIGNATURE_TYPES = ['rsa-pss-sha512', 'rsa-pss-sha256', 'ed25519-sha512'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Suites, fixtures and benches build commitments; they define no rule. The same
// list is checked in paralith-mono (backend/native/signature-types.test.mjs).
const SKIP = /(_test|test_|\.test\.|\/test\/|bench)/;

const files = execFileSync('git', ['ls-files', '*.lua'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && !SKIP.test(f));

/** Every `{ ... }` literal that lists rsa-pss-sha512 as a key, with its keys. */
function tables(text) {
  const out = [];
  let at = text.indexOf('["rsa-pss-sha512"]');
  while (at !== -1) {
    const open = text.lastIndexOf('{', at);
    const close = text.indexOf('}', at);
    const body = text.slice(open + 1, close);
    const line = text.slice(0, open).split('\n').length;
    out.push({ line, keys: [...body.matchAll(/\["([^"]+)"\]\s*=\s*true/g)].map((m) => m[1]) });
    at = text.indexOf('["rsa-pss-sha512"]', close);
  }
  return out;
}

test('signer-set tables exist to check', () => {
  assert.ok(files.flatMap((f) => tables(fs.readFileSync(path.join(ROOT, f), 'utf8'))).length >= 10);
});

for (const file of files) {
  const found = tables(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  if (found.length === 0) continue;
  test(`${file}: every signer set is exactly the accepted signature types`, () => {
    for (const { line, keys } of found) {
      assert.deepEqual([...keys].sort(), [...SIGNATURE_TYPES].sort(), `${file}:${line}`);
    }
  });
}
