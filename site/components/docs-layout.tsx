/* eslint-disable @next/next/no-html-link-for-pages -- full reloads avoid broken Vinext client navigation */
import { docPages, type DocPage } from "../lib/docs";
import { SiteFooter, SiteHeader } from "./site-header";

type Props = { current?: DocPage; children: React.ReactNode };

export function DocsLayout({ current, children }: Props) {
  return (
    <main className="shell docs-page">
      <SiteHeader active="docs" />
      <div className="docs-body container">
        <nav className="docs-sidebar" aria-label="Docs">
          <a className={current ? "docs-home" : "docs-home active"} href="/docs" aria-current={current ? undefined : "page"}>All docs</a>
          <ul>
            {docPages.map((page) => (
              <li key={page.slug}>
                <a href={`/docs/${page.slug}`} className={current?.slug === page.slug ? "active" : undefined}
                  aria-current={current?.slug === page.slug ? "page" : undefined}>{page.title}</a>
                {current?.slug === page.slug && page.headings.length > 0 && (
                  <ul className="docs-toc">
                    {page.headings.map((h) => <li key={h.id}><a href={`#${h.id}`}>{h.text}</a></li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <p className="docs-agents">For agents: <a href="/llms.txt">llms.txt</a>, <a href="/llms-full.txt">llms-full.txt</a>, <a href="/mcp">MCP</a> (POST).</p>
        </nav>
        <div className="docs-main">{children}</div>
      </div>
      <SiteFooter />
    </main>
  );
}
