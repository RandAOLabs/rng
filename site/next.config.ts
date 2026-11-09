import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /docs/<slug>.md serves the page's markdown (app/docs/md/[slug]/route.ts).
  async rewrites() {
    return { beforeFiles: [{ source: "/docs/:slug([a-z0-9-]+)\\.md", destination: "/docs/md/:slug" }], afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
