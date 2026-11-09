import {
  deriveBytes,
  extendedNetworkConfig,
  getAnyHonestStatus,
  getGovernanceStatus,
  getLivePrices,
  getNetworkStatus,
} from "../../lib/rng";
import { listDocs, readDoc, searchDocs, docPages } from "../../lib/docs";
import { DEPLOY } from "../../lib/docs-content.generated";
import { requestTemplates } from "../../lib/request-templates";

export const dynamic = "force-dynamic";

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const VERSION = "2026-07-28";

const tools = [
  {
    name: "rng_status",
    description: "Read the current HyperBEAM RNG network, committee, price and independently verified latest round.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "rng_verify_round",
    description: "Fetch and independently verify a retained HyperBEAM RNG round by number.",
    inputSchema: {
      type: "object",
      properties: { round: { type: "integer", minimum: 1 } },
      required: ["round"], additionalProperties: false,
    },
  },
  {
    name: "rng_anyhonest_status",
    description: "Read the continuous Any-Honest beacon and independently verify every contribution to its latest finalized round.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "rng_governance_status",
    description: "Read RNG governance parameters and proposals. Governance is a YapDAO (stake-dao/1) staking RNG; the DAO is the only owner after launch. Money and code actions take effect at their Effective-At, at least 24 h after they arrive; the rest on receipt.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "rng_derive",
    description: "Derive deterministic bytes using the canonical hyperbeam/rng/v1 framing.",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "string", minLength: 1, maxLength: 4096 },
        counter: { type: "integer", minimum: 0, default: 0 },
        bytes: { type: "integer", minimum: 1, maximum: 1024, default: 32 },
      },
      required: ["seed"], additionalProperties: false,
    },
  },
  {
    name: "rng_integration_guide",
    description: "Get a current Lua, JavaScript or HTTP integration guide for HyperBEAM RNG.",
    inputSchema: {
      type: "object",
      properties: { language: { type: "string", enum: ["lua", "javascript", "http"] } },
      required: ["language"], additionalProperties: false,
    },
  },
  {
    name: "rng_request_plan",
    description: "Explain which RNG operations need a wallet or test credits before an agent builds a flow.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "rng_docs_list",
    description: "List the RandAO RNG protocol docs (randao.net/docs): slug, title, summary, URLs and section ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "rng_docs_read",
    description: "Read one doc page as markdown, or one section of it by its heading id (from rng_docs_list or rng_docs_search).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", enum: docPages.map((page) => page.slug) },
        section: { type: "string", maxLength: 200 },
      },
      required: ["slug"], additionalProperties: false,
    },
  },
  {
    name: "rng_docs_search",
    description: "Search the protocol docs. Returns the best-matching sections (every term must appear) with snippets and links.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 8 },
      },
      required: ["query"], additionalProperties: false,
    },
  },
  {
    name: "rng_request_templates",
    description: "Live process ids, current prices and the exact message (target + tags) for every request type: Fast, Any-Honest, subscriptions, balances, withdrawals and fair play, with how each result arrives.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

async function liveTemplates() {
  const cfg = extendedNetworkConfig();
  const prices = await getLivePrices();
  const ids = { token: cfg.token, fast: cfg.beacon, anyHonest: cfg.anyHonest, fair: cfg.fair,
    dao: cfg.dao, subscriptionConsumer: DEPLOY.subscriptionConsumer, scheduler: DEPLOY.scheduler };
  // The site's env names the live ids; say so whenever deploy/v3-mainnet.json disagrees.
  const fromFile = { token: DEPLOY.token, fast: DEPLOY.fast, anyHonest: DEPLOY.anyHonest, fair: DEPLOY.fair, dao: DEPLOY.dao };
  const differ = Object.entries(fromFile).filter(([k, v]) => ids[k as keyof typeof fromFile] !== v).map(([k]) => k);
  return { network: cfg.label, ...requestTemplates(ids, prices), priceSource: prices.source,
    ...(differ.length ? { idsDifferFromDeployFile: differ } : {}), docs: "https://randao.net/docs/use" };
}

function textResult(value: unknown, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function guide(language: string) {
  const cfg = extendedNetworkConfig();
  if (language === "lua") return `local rng = require("rng")\n\nrng.on("Loot-Roll", function(stream, ctx)\n  grantLoot(ctx.player, stream:int(1, 6))\nend)\n\nrng.config({ fast = "${cfg.beacon}" })\nrng.request(msg, { tier = "fast", on = "Loot-Roll", ctx = { player = msg.From } })`;
  if (language === "javascript") return `const { rng } = connect({ MODE: "mainnet", URL: HYPERBEAM_URL })\n\nconst verified = await rng.verifyRound({\n  publicKey: GROUP_PUBLIC_KEY_HEX,\n  beacon: "${cfg.beacon}",\n  round,\n  signature\n}).then(r => r.json())\n\nconst bytes = await rng.derive({ seed: verified.value, counter: 0, bytes: 32 }).then(r => r.json())`;
  return `GET <hyperbeam-node>/${cfg.beacon}~process@1.0/now/beaconinfo\nGET <hyperbeam-node>/${cfg.beacon}~process@1.0/now/beaconstate\nGET <hyperbeam-node>/${cfg.anyHonest}~process@1.0/now/beaconinfo\nGET <hyperbeam-node>/${cfg.anyHonest}~process@1.0/now/timelockstate\n\nThreshold signing message: hyperbeam/rng/v1|<beacon>|<round>\nAny-Honest round domain: hyperbeam/rng/any-honest/v1/round`;
}

async function callTool(name: unknown, args: Record<string, unknown>) {
  if (name === "rng_status") return textResult(await getNetworkStatus());
  if (name === "rng_verify_round") {
    const round = Number(args.round);
    if (!Number.isSafeInteger(round) || round < 1) throw new Error("round must be a positive integer");
    return textResult(await getNetworkStatus(round));
  }
  if (name === "rng_anyhonest_status") return textResult(await getAnyHonestStatus());
  if (name === "rng_governance_status") return textResult(await getGovernanceStatus());
  if (name === "rng_derive") {
    if (typeof args.seed !== "string" || args.seed.length === 0 || args.seed.length > 4096) throw new Error("seed must be a non-empty string of at most 4096 characters");
    const counter = args.counter === undefined ? 0 : Number(args.counter);
    const bytes = args.bytes === undefined ? 32 : Number(args.bytes);
    return textResult({ seed: args.seed, counter, bytes, value: await deriveBytes(args.seed, counter, bytes) });
  }
  if (name === "rng_integration_guide") {
    if (!["lua", "javascript", "http"].includes(String(args.language))) throw new Error("language must be lua, javascript or http");
    return textResult(guide(String(args.language)));
  }
  if (name === "rng_request_plan") return textResult({
    productSurfaces: {
      local: { status: "live", contract: "deterministic and predictable to the sender" },
      fast: { status: "live", contract: "on-demand 2-of-3 threshold BLS; rounds only for paid requests, no heartbeat; safe unless 2 of 3 operators collude" },
      beacon: { status: "live", contract: "Foundation-funded continuous Any-Honest public rounds" },
      anyHonest: { status: "live", contract: "time-lock commit/reveal verified by ~rng@1.0" },
      proofExplorer: { status: "live", contract: "independent retained-round verification" },
    },
    device: "One ~rng@1.0 namespace for derivation, BLS verification, and the restored time-lock checks.",
    free: ["local deterministic streams", "round reads", "signature verification", "byte derivation"],
    paid: {
      fastRequest: "3 RNG",
      anyHonestRequest: "4 RNG",
      secureSubscription: "1 RNG for 1,000 authenticated process pushes",
      buy: "No faucet: RNG is a fixed-supply token; buy it on the Paralith orderbook (RNG/GOLD, coming soon)",
    },
    deliveryTrust: "Public reads are free but trust the selected gateway view. A prepaid process subscription binds before reveal and receives the authenticated result from the beacon process.",
    governance: "YapDAO (stake-dao/1) staked in RNG governs the beacon: passed proposals send Gov.* actions. The launch wallet renounces at launch, so the DAO is the only owner of the beacon, fair play and the fast tier. Money and code actions wait for their Effective-At (at least 24 h after they arrive; published as `govPending`), and while one waits validators may leave at once with their bond (Exit-Now, `hatch` in beaconinfo); fees, pause and resume apply on receipt. Owners are published as `gov` in beaconinfo. There is no guardian.",
    recommendedUX: "The AO application process should prepay requests or a subscription so end users never manage RNG credits.",
  });
  if (name === "rng_docs_list") return textResult(listDocs());
  if (name === "rng_docs_read") {
    const section = args.section === undefined ? undefined : String(args.section);
    const doc = readDoc(String(args.slug), section);
    if (!doc) throw new Error(section ? `no section "${section}" in doc "${String(args.slug)}"` : `unknown doc: ${String(args.slug)}`);
    return textResult(doc.markdown);
  }
  if (name === "rng_docs_search") {
    if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 200) throw new Error("query must be a non-empty string of at most 200 characters");
    const limit = args.limit === undefined ? 8 : Number(args.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error("limit must be an integer from 1 to 25");
    return textResult(searchDocs(args.query, limit));
  }
  if (name === "rng_request_templates") return textResult(await liveTemplates());
  throw new Error(`unknown tool: ${String(name)}`);
}

export async function POST(request: Request) {
  let rpc: RpcRequest;
  try { rpc = await request.json() as RpcRequest; }
  catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 }); }
  const id = rpc.id ?? null;
  try {
    let result: unknown;
    if (rpc.method === "server/discover") result = { supportedVersions: [VERSION], capabilities: { tools: {} } };
    else if (rpc.method === "tools/list") result = { tools };
    else if (rpc.method === "tools/call") {
      const params = rpc.params ?? {};
      result = await callTool(params.name, (params.arguments ?? {}) as Record<string, unknown>);
    } else return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }, { status: 404 });
    return Response.json({ jsonrpc: "2.0", id, result });
  } catch (error) {
    return Response.json({ jsonrpc: "2.0", id, result: textResult(error instanceof Error ? error.message : "Tool failed", true) });
  }
}
