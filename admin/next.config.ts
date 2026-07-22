import type { NextConfig } from "next";

const apiTarget = process.env.API_PROXY_TARGET || "http://127.0.0.1:8788";

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
    ];
  },
};

export default nextConfig;
