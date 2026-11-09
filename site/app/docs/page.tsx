/* eslint-disable @next/next/no-html-link-for-pages -- full reloads avoid broken Vinext client navigation */
import type { Metadata } from "next";
import { DocsLayout } from "../../components/docs-layout";
import { docPages } from "../../lib/docs";

export const metadata: Metadata = {
  title: "Docs — RNG Labs",
  description: "RandAO RNG protocol docs: how to request randomness on each tier, the v3 whitepaper, architecture and specs.",
};

export default function DocsIndex() {
  return (
    <DocsLayout>
      <article className="docs-content">
        <h1>Docs</h1>
        <p>
          How RandAO RNG works and how to use it. These pages are built from the <code>docs/</code> folder of
          the <a href="https://github.com/RandAOLabs/rng">repository</a>, so they match the code they describe.
          To request randomness, start with <a href="/docs/use">Use it</a>.
        </p>
        <ul className="docs-index">
          {docPages.map((page) => (
            <li key={page.slug}>
              <a href={`/docs/${page.slug}`}>{page.title}</a>
              <span>{page.summary}</span>
            </li>
          ))}
        </ul>
        <h2>For agents</h2>
        <p>
          Every page is also plain markdown at <code>/docs/&lt;slug&gt;.md</code>.{" "}
          <a href="/llms.txt">/llms.txt</a> indexes them and <a href="/llms-full.txt">/llms-full.txt</a> is all of
          them in one file. The MCP server at <code>POST /mcp</code> can list, read and search these docs, and
          returns the live process ids, prices and exact message templates (<code>rng_request_templates</code>).
        </p>
      </article>
    </DocsLayout>
  );
}
