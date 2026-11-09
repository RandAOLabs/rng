import { llmsIndex } from "../../lib/docs";
import { extendedNetworkConfig } from "../../lib/rng";

export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = extendedNetworkConfig();
  const text = llmsIndex({ network: cfg.label, fast: cfg.beacon, anyHonest: cfg.anyHonest, dao: cfg.dao, token: cfg.token, fair: cfg.fair });
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
