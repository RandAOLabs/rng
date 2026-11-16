// node send.mjs <pid> <Action> [Tag=Value ...] [--live]   (HB_WALLET, NODE). Without --live it prints only.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const hb = await import(pathToFileURL('C:/REPO/paralith-purge/backend/native/hbclient.mjs').href);
const argv = process.argv.slice(2);
const live = argv.includes('--live');
const [pid, action, ...kv] = argv.filter((a) => a !== '--live');
const tags = Object.fromEntries(kv.map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const node = process.env.NODE;
if (!/^[A-Za-z0-9_-]{43}$/.test(pid || '') || !action || !node) throw new Error('send.mjs <pid> <Action> [Tag=Value] (NODE, HB_WALLET)');
console.log(JSON.stringify({ live, node, process: pid, action, tags }));
if (!live) process.exit(0);
const jwk = JSON.parse(fs.readFileSync(process.env.HB_WALLET, 'utf8'));
const { slot } = await hb.sendMessage({ node, jwk, process: pid, action, tags });
await hb.awaitComputedSlot({ node, process: pid, slot });
const out = await hb.readState({ node, process: pid, path: `compute&slot=${slot}/results/output/data` });
console.log(JSON.stringify({ slot, output: out.value }));
