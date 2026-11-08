// sendMessage remembers which schedule route a node accepts. It must remember
// the route, not one process's path: messages to two processes in one run must
// each reach their own schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sendMessage } from '../vendor/hbclient.mjs';

test('sendMessage caches the route template per node, not the first pid', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  const A = 'A'.repeat(43);
  const B = 'B'.repeat(43);
  const posts = [];
  const realFetch = globalThis.fetch;
  // This node only accepts the device-qualified scheduler route, so the first
  // send falls through one 404 and caches the second spelling.
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    posts.push(path);
    const m = path.match(/^\/([A-Za-z0-9_-]{43})~scheduler@1\.0\/schedule$/);
    if (m && (m[1] === A || m[1] === B)) {
      return new Response('', { status: 200, headers: { slot: String(posts.length) } });
    }
    return new Response('not_found', { status: 404 });
  };
  try {
    const node = 'http://hb.test';
    await sendMessage({ node, jwk, process: A, action: 'Ping', push: false });
    await sendMessage({ node, jwk, process: B, action: 'Ping', push: false });
    await sendMessage({ node, jwk, process: A, action: 'Ping', push: false });
    assert.deepEqual(posts, [
      `/${A}~process@1.0/schedule`,
      `/${A}~scheduler@1.0/schedule`,
      `/${B}~scheduler@1.0/schedule`,
      `/${A}~scheduler@1.0/schedule`,
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
