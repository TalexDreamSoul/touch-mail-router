import type { NextConfig } from "next";

// Prefer .env.local API_PROXY_TARGET; default matches local server PORT=8789
// (8788 is often occupied by other tools on this machine).
const apiTarget = process.env.API_PROXY_TARGET || "http://127.0.0.1:8789";

const nextConfig: NextConfig = {
  output: "standalone",
  // Avoid monorepo parent lockfile confusing Turbopack root
  turbopack: {
    root: process.cwd(),
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiTarget}/api/:path*`,
      },
      {
        source: "/health",
        destination: `${apiTarget}/health`,
      },
      {
        source: "/v1/:path*",
        destination: `${apiTarget}/v1/:path*`,
      },
      // AI-native + DuckMail discovery via same origin (optional for local admin)
      {
        source: "/ai/:path*",
        destination: `${apiTarget}/ai/:path*`,
      },
    ];
  },
};

export default nextConfig;
