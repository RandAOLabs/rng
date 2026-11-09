// /docs/<slug>.md (next.config.ts rewrites it here): one page as markdown.
import { docMarkdown, getDoc } from "../../../../lib/docs";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const page = getDoc((await params).slug);
  if (!page) return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(docMarkdown(page), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
}
