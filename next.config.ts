import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // native / server-only modules must not be bundled
  serverExternalPackages: ["better-sqlite3"],
  cacheComponents: true,
  // the dev-only "N" badge sits bottom-left by default, on top of the rail's account avatar
  devIndicators: { position: "bottom-right" },
  // dev only: lets 127.0.0.1 hydrate, a separate origin (own localStorage) for checking the mockups with sample data
  allowedDevOrigins: ["127.0.0.1"],
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
