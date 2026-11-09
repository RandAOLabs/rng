import { llmsFull } from "../../lib/docs";

export function GET() {
  return new Response(llmsFull(), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
