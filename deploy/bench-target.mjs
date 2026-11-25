// Which node an RNG bench or e2e may spawn and spend on, and how to start a
// throwaway one. Shared by fast-e2e, anyhonest-e2e and bench-beacons.
//
// A bench spawns processes and spends tokens, so it runs only against:
//   - a node it starts itself (--image <tag>: a docker container on this box), or
//   - a local node (HB_NODE / --node http://127.0.0.1:<port>), or
//   - a remote bench node named with --node <url> AND --remote, which is never
//     one of the live nodes below.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** The live nodes (paralith-mono infra/nodes/nodes.json) and their domains. */
const LIVE = [/^138\.201\.220\.159$/, /^176\.9\.219\.106$/, /^49\.12\.125\.122$/,
  /(^|\.)tylerw\.ai$/i, /(^|\.)paralithmarkets\.com$/i, /(^|\.)cipherplay\.net$/i, /(^|\.)cypherplay\.net$/i];

export const isLocalNode = (url) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url || '');

/** The node a bench may use, or a thrown reason. */
export function benchNode(url, { argv = process.argv } = {}) {
  if (!url) throw new Error('pass --image <tag> (a node of its own), or --node <url> (local, or remote with --remote): this spawns and spends');
  if (isLocalNode(url)) return url.replace(/\/$/, '');
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error(`not a URL: ${url}`); }
  if (LIVE.some((re) => re.test(host))) throw new Error(`${host} is a live node: never bench it`);
  if (!argv.includes('--remote')) throw new Error(`${url} is not local: pass --remote to bench a remote bench node`);
  return url.replace(/\/$/, '');
}

/** The node config a throwaway bench node runs: local scheduling, no rate
 *  limit, the production snapshot cadence (paralith-mono
 *  infra/nodes/node-config.v011.json; the default snapshots a wasm-patch
 *  process's whole memory every slot). */
export function benchNodeConfig() {
  const lmdb = { 'store-module': 'hb_store_lmdb', name: '/app/cache-mainnet/lmdb', capacity: 64 * 1024 ** 3, sync: false,
    'ao-types': 'store-module="atom", capacity="integer"' };
  return {
    'scheduling-mode': 'local_confirmation', 'scheduler-lookahead': false, 'scheduler-publish-remote': false,
    'force-signed': false, 'store-all-signed': false,
    'rate-limit-requests': 1000000, 'rate-limit-period': 60, 'rate-limit-max': 1000000, 'rate-limit-min': -1000000,
    'process-snapshot-time': 900, 'process-snapshot-slots': 1000, 'process-snapshot-target': false,
    'process-delta-checkpoint-slots': 1000,
    store: [lmdb, { 'store-module': 'hb_store_fs', name: '/app/cache-mainnet', 'ao-types': 'store-module="atom"' }],
  };
}

/** Start `image` as docker container `name` on 127.0.0.1:`port` (removed on
 *  exit unless keep); resolves to its URL once it answers. */
export async function startBenchNode({ image, port, name, dir, keep = false, log = () => {} }) {
  const docker = (...a) => execFileSync('docker', a, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).toString();
  const jwk = { kty: 'RSA', ...crypto.generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 65537 })
    .privateKey.export({ format: 'jwk' }) };
  fs.mkdirSync(path.join(dir, 'node', 'keys'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node', 'keys', 'node-key.json'), JSON.stringify(jwk), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'node', 'node-config.json'), JSON.stringify(benchNodeConfig()));
  try { docker('rm', '-f', name); } catch { /* none */ }
  docker('create', '--name', name, '-p', `127.0.0.1:${port}:10000`, '-e', 'HB_PORT=10000',
    '-e', 'HB_KEY=/app/keys/node-key.json', '-e', 'HB_CONFIG=/app/node-config.json', '-e', 'HB_PRINT=error', image);
  docker('cp', path.join(dir, 'node', 'keys'), `${name}:/app/keys`);
  docker('cp', path.join(dir, 'node', 'node-config.json'), `${name}:/app/node-config.json`);
  docker('start', name);
  if (!keep) process.on('exit', () => { try { docker('rm', '-f', name); } catch { /* gone */ } });
  const url = `http://127.0.0.1:${port}`;
  // A timer keeps the event loop alive while the node boots (a pending fetch
  // alone did not, and node exited with an unsettled await).
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${url}/~meta@1.0/info/address`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* starting */ }
      if (i > 120) throw new Error(`${image} did not come up; docker logs ${name}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally { clearInterval(keepAlive); }
  log(`node ${image} up at ${url}`);
  return url;
}
