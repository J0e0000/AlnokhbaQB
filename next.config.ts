import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/@sparticuz/chromium/bin/**", "./public/fonts/**"],
  },
  /* config options here */
  typescript: {
    // CI runs `tsc --noEmit` as a blocking gate (see .github/workflows/ci.yml);
    // build must NOT silently ignore type errors anymore.
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
