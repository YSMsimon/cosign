import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // native / server-only modules must not be bundled
  serverExternalPackages: ["better-sqlite3", "@circle-fin/app-kit", "@circle-fin/adapter-circle-wallets"],
  cacheComponents: true,
  // no dev-only "N" badge: it showed in screenshots and the demo recording (errors still open the overlay)
  devIndicators: false,
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
