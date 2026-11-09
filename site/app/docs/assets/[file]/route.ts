// /docs/assets/<name>.svg: the architecture diagrams from docs/architecture/.
import { getAsset } from "../../../../lib/docs";

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const match = (await params).file.match(/^([a-z-]+)\.svg$/);
  const svg = match ? getAsset(match[1]) : undefined;
  if (!svg) return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}
