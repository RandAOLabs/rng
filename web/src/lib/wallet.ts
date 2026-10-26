// Writes from the page: the wallet signs an ANS-104 data item, the node
// schedules it, and a push delivers whatever the slot's outbox holds.
import { NODE } from './config';

type ArweaveWallet = {
  connect(permissions: string[], appInfo?: object): Promise<void>;
  getActiveAddress(): Promise<string>;
  signDataItem(item: { data: string; target: string; tags: { name: string; value: string }[] }): Promise<ArrayBuffer>;
};
declare global { interface Window { arweaveWallet?: ArweaveWallet } }

const PERMISSIONS = ['ACCESS_ADDRESS', 'ACCESS_PUBLIC_KEY', 'SIGN_TRANSACTION'];

export function hasWallet() { return typeof window !== 'undefined' && !!window.arweaveWallet; }

export async function connect(): Promise<string> {
  const w = window.arweaveWallet;
  if (!w) throw new Error('No Arweave wallet found. Install Wander, then reload this page.');
  await w.connect(PERMISSIONS, { name: 'RNG' });
  return w.getActiveAddress();
}

/** Send one message; resolves with the process's reply once the slot is computed. */
export async function send(pid: string, tags: Record<string, string>, data = ''): Promise<{ slot: number; reply: any }> {
  const w = window.arweaveWallet;
  if (!w) throw new Error('Connect a wallet first.');
  const signed = await w.signDataItem({ data, target: pid, tags: Object.entries(tags).map(([name, value]) => ({ name, value })) });
  const res = await fetch(`${NODE}/${pid}~process@1.0/schedule?codec-device=ans104@1.0`, {
    method: 'POST', headers: { 'content-type': 'application/ans104', 'accept-bundle': 'true' }, body: new Uint8Array(signed),
  });
  if (!res.ok) throw new Error(`The node refused the message (${res.status}). ${res.headers.get('details') ?? ''}`);
  const slot = Number(res.headers.get('slot'));
  // Computing the slot and delivering its outbox (e.g. a token's Credit-Notice).
  await fetch(`${NODE}/${pid}~process@1.0/push&slot=${slot}`);
  const out = await fetch(`${NODE}/${pid}~process@1.0/compute&slot=${slot}/results/output/data`);
  const text = await out.text();
  let reply: any = text;
  try { reply = JSON.parse(text); } catch { /* plain text reply */ }
  return { slot, reply };
}
