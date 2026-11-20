import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
  serverExternalPackages: ["better-sqlite3"],
  // These are runtime-local state, not deployment assets. A production CA
  // bundle must be provisioned separately, never copied from the dev stack.
  outputFileTracingExcludes: {
    "/*": [
      "./.env*", "./.git/**/*", "./.auth/**/*", "./.data/**/*",
      "./nova-leads.db*", "./nosite-leads.db*", "./supabase/local/certs/**/*",
      "./staging-artifacts/**/*", "./data-export/**/*",
      "./test-results/**/*", "./playwright-report/**/*",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
