import type { NextConfig } from "next";

// `output: "standalone"` serves the SELF-HOSTED artifact (z.ai publish flow,
// VPS /app/next-service-dist, Docker). On Vercel the platform bundles server
// functions itself and the runtime FS is read-only — keep the default output
// there so its builder behaves normally.
const isVercel = !!process.env.VERCEL;

const nextConfig: NextConfig = {
  ...(isVercel ? {} : { output: "standalone" as const }),
  // OMR batch uploads ship whole scanned-stacks as base64 PDFs (40MB cap in
  // the route) — raise the middleware body limit so they aren't truncated.
  experimental: {
    middlewareClientMaxBodySize: "50mb",
  },
  // Files read at RUNTIME via fs.* (invisible to static import tracing):
  //  - db/custom.db          → serverless bootstrap copies it into /tmp
  //                            (src/lib/db.ts)
  //  - public/fonts/*.woff2  → PDF renderer inlines them as data: URLs
  //                            (src/lib/pdf/pool.ts)
  //  - @sparticuz/chromium   → serverless Chromium ships as compressed assets
  //                            inside its package dir, extracted to /tmp on
  //                            first launch (src/lib/pdf/pool.ts)
  outputFileTracingIncludes: {
    "/**": ["./db/custom.db", "./public/fonts/**"],
    "/api/health": ["./node_modules/@sparticuz/chromium/**"],
    "/api/exams/[id]/pdf": ["./node_modules/@sparticuz/chromium/**"],
    "/api/versions/[id]/pdf": ["./node_modules/@sparticuz/chromium/**"],
    "/api/versions/[id]/omr-png": ["./node_modules/@sparticuz/chromium/**"],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
