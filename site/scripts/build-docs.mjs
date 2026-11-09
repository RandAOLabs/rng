// Builds lib/docs-content.generated.ts from the repo's docs/ markdown, the
// architecture SVGs and deploy/v3-mainnet.json, so the site has one source of
// truth. Runs before dev, build and test (package.json pre-scripts).
// Fails when a doc names a 43-character id that deploy/v3-mainnet.json does not.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const ROOT = path.resolve(SITE, "..");
const OUT = path.join(SITE, "lib", "docs-content.generated.ts");
export const ORIGIN = "https://randao.net";
const REPO = "https://github.com/RandAOLabs/rng";

/** The rendered pages, in sidebar order. */
export const PAGES = [
  { slug: "use", source: "docs/USE.md", summary: "How a wallet or a process requests randomness on each tier: messages, prices, balances, results, fair play." },
  { slug: "whitepaper", source: "docs/whitepaper/README.md", summary: "The v3 whitepaper: tiers, the Any-Honest beacon, Fast, fair play, governance, token, pricing, security." },
  { slug: "architecture", source: "docs/ARCHITECTURE.md", summary: "Live processes and diagrams of rounds, requests, fair sessions, governance and money flows." },
  { slug: "any-honest", source: "docs/ANY_HONEST.md", summary: "The Any-Honest time-lock beacon: validators, rounds, cracks, published keys, subscriptions." },
  { slug: "permissionless", source: "docs/PERMISSIONLESS.md", summary: "The v3 design record. Its \"Governance at launch\" section is current." },
  { slug: "spec", source: "docs/SPEC.md", summary: "Protocol spec of the threshold-BLS (Fast) surface: framing, derivation, verification." },
];

// docs/architecture/README.md: the Mermaid blocks of ARCHITECTURE.md, in order.
const ARCH_SVGS = ["system-map", "any-honest-round", "fast-request", "fair-session", "governance", "money-flows"];

/** GitHub-style heading anchor. */
export function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function plain(markdown) {
  return markdown.replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/** Rewrite one link target. mode "html": site paths; "md": absolute URLs for agents. */
function rewriteHref(href, sourceDir, mode) {
  if (/^[a-z]+:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return href;
  const [file, hash = ""] = href.split("#");
  const anchor = hash ? `#${hash}` : "";
  const repoPath = path.posix.normalize(path.posix.join(sourceDir, file)).replace(/\/$/, "");
  const page = PAGES.find((p) => p.source === repoPath || p.source === `${repoPath}/README.md`);
  if (page) return mode === "html" ? `/docs/${page.slug}${anchor}` : `${ORIGIN}/docs/${page.slug}.md${anchor}`;
  const svg = repoPath.match(/^docs\/architecture\/([a-z-]+)\.svg$/);
  if (svg) return `${mode === "html" ? "" : ORIGIN}/docs/assets/${svg[1]}.svg`;
  // Not the filesystem: the Docker build copies only part of the repo.
  const kind = file.endsWith("/") || !path.posix.extname(repoPath) ? "tree" : "blob";
  return `${REPO}/${kind}/main/${repoPath}${anchor}`;
}

/** Rewrite every markdown link outside fenced code. */
export function rewriteLinks(markdown, source, mode) {
  const dir = path.posix.dirname(source);
  return markdown.split(/(```[\s\S]*?```)/g).map((part, i) =>
    i % 2 ? part : part.replace(/(!?\[[^\]]*\])\(([^)\s]+)\)/g, (_, label, href) => `${label}(${rewriteHref(href, dir, mode)})`)).join("");
}

function render(markdown, slug) {
  const seen = new Map();
  const headings = [];
  let figure = 0;
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        const base = slugify(plain(text));
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        headings.push({ depth, text: plain(text), id });
        return `<h${depth} id="${id}"><a class="doc-anchor" href="#${id}">${this.parser.parseInline(tokens)}</a></h${depth}>\n`;
      },
      code({ lang }) {
        if (lang !== "mermaid") return false;
        const name = ARCH_SVGS[figure++];
        if (slug !== "architecture" || !name) throw new Error(`unexpected mermaid block in ${slug}`);
        const caption = headings.at(-1)?.text ?? name;
        return `<figure class="doc-figure"><a href="/docs/assets/${name}.svg"><img src="/docs/assets/${name}.svg" alt="${caption} diagram" loading="lazy"></a><figcaption>${caption}. Source: the Mermaid block in <a href="/docs/architecture.md">architecture.md</a>.</figcaption></figure>\n`;
      },
      // GFM autolinks "lua-patch@1.0" as an email address: keep it text.
      link(token) {
        if (token.href.startsWith("mailto:")) return this.parser.parseInline(token.tokens);
        return false;
      },
      table(token) {
        return `<div class="doc-table">${marked.Renderer.prototype.table.call(this, token)}</div>`;
      },
    },
  });
  const html = marked.parse(markdown);
  if (slug === "architecture" && figure !== ARCH_SVGS.length) throw new Error(`architecture has ${figure} diagrams, expected ${ARCH_SVGS.length}`);
  return { html, headings };
}

/** Sections (by h1-h3) for search. */
function sections(markdown, headings) {
  const out = [];
  let current = { id: "", heading: "", lines: [] };
  let inCode = false, h = 0;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inCode = !inCode;
    const m = !inCode && line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const heading = headings[h++];
      if (m[1].length <= 3) {
        if (current.lines.join("").trim()) out.push(current);
        current = { id: heading.id, heading: heading.text, lines: [] };
        continue;
      }
    }
    current.lines.push(line);
  }
  if (current.lines.join("").trim()) out.push(current);
  return out.map(({ id, heading, lines }) => ({ id, heading, text: lines.join("\n").trim() }));
}

/** The 43-character ids in `text` that the deploy file does not know. */
export function unknownIds(text, deploy) {
  const known = new Set([deploy.deployer, deploy.scheduler, ...Object.keys(deploy.processes)]);
  for (const p of Object.values(deploy.processes)) known.add(p.scheduler);
  for (const r of deploy.retired ?? []) known.add(r.pid);
  for (const r of deploy.genesis?.rows ?? []) known.add(r.address);
  return (text.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g) ?? [])
    .filter((id) => /[A-Z0-9]/.test(id) && /[a-z]/.test(id) && !known.has(id));
}

export function build() {
  const deploy = JSON.parse(fs.readFileSync(path.join(ROOT, "deploy/v3-mainnet.json"), "utf8"));
  const params = JSON.parse(fs.readFileSync(path.join(ROOT, "deploy/v3-params.json"), "utf8"));
  const committee = JSON.parse(fs.readFileSync(path.join(ROOT, "deploy/committee.json"), "utf8"));
  const pages = PAGES.map((p) => {
    const raw = fs.readFileSync(path.join(ROOT, p.source), "utf8").replace(/\r\n/g, "\n");
    const unknown = unknownIds(raw, deploy);
    if (unknown.length) throw new Error(`${p.source} names ${unknown.join(", ")}, which deploy/v3-mainnet.json does not know`);
    const title = raw.match(/^#\s+(.+)$/m)?.[1].trim() ?? p.slug;
    const { html, headings } = render(rewriteLinks(raw, p.source, "html"), p.slug);
    let n = 0;
    const markdown = rewriteLinks(raw, p.source, "md").replace(/```mermaid\n[\s\S]*?```/g,
      (block) => `${block}\n\nRendered: ${ORIGIN}/docs/assets/${ARCH_SVGS[n++]}.svg`);
    return { slug: p.slug, title: plain(title), summary: p.summary, source: p.source, markdown, html,
      headings: headings.filter((x) => x.depth === 2), sections: sections(raw, headings) };
  });
  const assets = Object.fromEntries(ARCH_SVGS.map((name) =>
    [name, fs.readFileSync(path.join(ROOT, `docs/architecture/${name}.svg`), "utf8")]));
  const live = {
    token: deploy.token, dao: deploy.dao, anyHonest: deploy.beacon, fast: deploy.fast, fair: deploy.fair,
    subscriptionConsumer: deploy.subscriptionConsumer, scheduler: deploy.scheduler, deployer: deploy.deployer,
    retired: (deploy.retired ?? []).map((r) => ({ role: r.role, pid: r.pid, retiredAt: r.retiredAt })),
  };
  const defaults = {
    unit: 10 ** Number(deploy.daoRules?.["Dao-Denomination"] ?? 6),
    anyHonest: { request: params.requestPrice, subscription: params.subscriptionPrice, subscriptionRounds: params.subscriptionRounds, round: params.roundPrice, crackBounty: params.crackBounty },
    // deploy.mjs fastGenesisConfig: signerFee 1, protocolFee 1; price = t x signerFee + protocolFee.
    fast: { request: committee.t + 1, signerFee: 1, protocolFee: 1, threshold: committee.t },
    fairWindowMs: params.fairWindowMs,
  };
  const body = `// Generated by scripts/build-docs.mjs from docs/ and deploy/. Do not edit.
export const DOC_PAGES = ${JSON.stringify(pages)} as const;
export const DOC_ASSETS: Record<string, string> = ${JSON.stringify(assets)};
export const DEPLOY = ${JSON.stringify(live)} as const;
export const DEFAULT_PRICES = ${JSON.stringify(defaults)} as const;
`;
  fs.writeFileSync(OUT, body);
  return { pages: pages.length, bytes: body.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = build();
  console.log(`docs: ${r.pages} pages, ${Math.round(r.bytes / 1024)} KB -> lib/docs-content.generated.ts`);
}
