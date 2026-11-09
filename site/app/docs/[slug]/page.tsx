import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsLayout } from "../../../components/docs-layout";
import { docPages, getDoc } from "../../../lib/docs";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return docPages.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = getDoc((await params).slug);
  return page ? { title: `${page.title} — RNG Labs docs`, description: page.summary } : {};
}

export default async function DocPage({ params }: Props) {
  const page = getDoc((await params).slug);
  if (!page) notFound();
  return (
    <DocsLayout current={page}>
      <p className="docs-source">
        <a href={`/docs/${page.slug}.md`}>Markdown</a>
        {" · "}
        <a href={`https://github.com/RandAOLabs/rng/blob/main/${page.source}`}>{page.source}</a>
      </p>
      {/* Rendered at build time from the repo's own docs (scripts/build-docs.mjs). */}
      <article className="docs-content" dangerouslySetInnerHTML={{ __html: page.html }} />
    </DocsLayout>
  );
}
