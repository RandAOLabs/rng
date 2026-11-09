// The protocol docs, built from docs/ by scripts/build-docs.mjs. Pure: no
// network, no Worker bindings, so routes and tests share it.
import { DOC_ASSETS, DOC_PAGES } from "./docs-content.generated";

export const SITE_ORIGIN = "https://randao.net";

export type DocPage = (typeof DOC_PAGES)[number];

export const docPages: readonly DocPage[] = DOC_PAGES;

export function getDoc(slug: string): DocPage | undefined {
  return docPages.find((page) => page.slug === slug);
}

export function getAsset(name: string): string | undefined {
  return Object.hasOwn(DOC_ASSETS, name) ? DOC_ASSETS[name] : undefined;
}

export const docUrl = (slug: string) => `${SITE_ORIGIN}/docs/${slug}`;
export const docMarkdownUrl = (slug: string) => `${SITE_ORIGIN}/docs/${slug}.md`;

/** One page as served at /docs/<slug>.md: its markdown, links made absolute. */
export function docMarkdown(page: DocPage) {
  return `${page.markdown.trimEnd()}\n\n---\nSource: ${page.source} in https://github.com/RandAOLabs/rng (rendered at ${docUrl(page.slug)})\n`;
}

/** A page, or one section of it by heading id. */
export function readDoc(slug: string, section?: string) {
  const page = getDoc(slug);
  if (!page) return null;
  if (!section) return { slug, title: page.title, url: docMarkdownUrl(slug), markdown: docMarkdown(page) };
  const hit = page.sections.find((s) => s.id === section);
  if (!hit) return null;
  return { slug, title: page.title, section: hit.id, heading: hit.heading,
    url: `${docUrl(slug)}#${hit.id}`, markdown: `## ${hit.heading}\n\n${hit.text}\n` };
}

export function listDocs() {
  return docPages.map((page) => ({ slug: page.slug, title: page.title, summary: page.summary,
    url: docUrl(page.slug), markdown: docMarkdownUrl(page.slug),
    sections: page.sections.filter((s) => s.id).map((s) => ({ id: s.id, heading: s.heading })) }));
}

const terms = (query: string) => query.toLowerCase().split(/[^\p{L}\p{N}._-]+/u).filter((t) => t.length > 1);

/** Sections that contain every term, best first: heading hits weigh more than body hits. */
export function searchDocs(query: string, limit = 8) {
  const words = terms(query);
  if (words.length === 0) return [];
  const hits: Array<{ slug: string; title: string; section: string; heading: string; url: string; score: number; snippet: string }> = [];
  for (const page of docPages) {
    for (const section of page.sections) {
      const heading = section.heading.toLowerCase();
      const body = section.text.toLowerCase();
      let score = 0;
      let first = -1;
      for (const word of words) {
        const inHeading = heading.includes(word);
        const count = body.split(word).length - 1;
        if (!inHeading && count === 0) { score = 0; break; }
        score += (inHeading ? 10 : 0) + Math.min(count, 10);
        const at = body.indexOf(word);
        if (at >= 0 && (first < 0 || at < first)) first = at;
      }
      if (score === 0) continue;
      const start = Math.max(0, first - 120);
      const snippet = section.text.slice(start, start + 320).replace(/\s+/g, " ").trim();
      hits.push({ slug: page.slug, title: page.title, section: section.id, heading: section.heading,
        url: section.id ? `${docUrl(page.slug)}#${section.id}` : docUrl(page.slug), score,
        snippet: `${start > 0 ? "..." : ""}${snippet}${start + 320 < section.text.length ? "..." : ""}` });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 25)));
}

/** /llms-full.txt: every page as plain markdown, in sidebar order. */
export function llmsFull() {
  const parts = docPages.map((page) => `<!-- ${docMarkdownUrl(page.slug)} -->\n\n${docMarkdown(page)}`);
  return `# RandAO RNG protocol docs (full text)\n\nAll pages of ${SITE_ORIGIN}/docs, concatenated. Index: ${SITE_ORIGIN}/llms.txt\n\n${parts.join("\n\n")}`;
}

export type LiveIds = { network: string; fast: string; anyHonest: string; dao: string; token: string; fair: string };

/** /llms.txt: an index of every doc page plus the live entry points. */
export function llmsIndex(live: LiveIds) {
  const pages = docPages.map((page) => `- [${page.title}](${docMarkdownUrl(page.slug)}): ${page.summary}`).join("\n");
  return `# RandAO RNG

> Verifiable randomness for AO processes on HyperBEAM, at three strengths: local (free,
> predictable to the sender), Fast (2-of-3 threshold BLS, on demand, 3 RNG) and Any-Honest
> (a time-lock commit-reveal beacon, safe if one validator in the round is honest, 4 RNG).
> Fair play adds the player's browser as one more honest party.

Every page below is plain markdown. All of them in one file: ${SITE_ORIGIN}/llms-full.txt.
The rendered pages are at ${SITE_ORIGIN}/docs.

## Docs

${pages}

## Live processes (${live.network})

- Fast tier: ${live.fast}
- Any-Honest beacon: ${live.anyHonest}
- Fair play: ${live.fair}
- RNG token: ${live.token}
- RNG DAO: ${live.dao}

Prices change only by DAO vote; read them live (beaconinfo) or from the MCP tool
rng_request_templates before paying.

## Agent entry points

- GET /api/status
- POST /api/derive
- POST /mcp (MCP 2026-07-28)

MCP tools: rng_status, rng_verify_round, rng_anyhonest_status, rng_governance_status,
rng_derive, rng_integration_guide, rng_request_plan, rng_docs_list, rng_docs_read,
rng_docs_search, rng_request_templates.

## Optional

- [Source repository](https://github.com/RandAOLabs/rng): protocol/, lib/, validator/, deploy/.
`;
}
