import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @circa/guide-schema ships TypeScript source (no build step), so Next must compile it.
  transpilePackages: ["@circa/guide-schema"],
};

export default nextConfig;
