import path from "node:path";
import type { NextConfig } from "next";

/**
 * API-only Next app. It imports the generated ABIs and addresses from
 * `../config`, which sits outside this directory, so the build root is the
 * repo root rather than `server/`.
 */
const repoRoot = path.join(__dirname, "..");

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  experimental: { externalDir: true },
  // Native binaries and node-only clients are loaded from node_modules at
  // runtime rather than bundled.
  serverExternalPackages: [
    "sharp",
    "@ffmpeg-installer/ffmpeg",
    "@ffprobe-installer/ffprobe",
    "pg",
    "mongodb",
  ],
  // Never ship local env files: runtime secrets come from the host's
  // environment (set with scripts/vercel-secrets.sh), not from the bundle.
  outputFileTracingExcludes: {
    "*": ["**/.env", "**/.env.*"],
    // Functions run on linux-arm64 (scripts/deploy-api.sh installs those
    // binaries before building); the macOS ones would only add weight.
    "/api/juno/upload": [
      "./node_modules/@ffmpeg-installer/darwin-*/**",
      "./node_modules/@ffprobe-installer/darwin-*/**",
      "./node_modules/@img/*darwin*/**",
    ],
  },
  outputFileTracingIncludes: {
    "/api/juno/upload": [
      "./node_modules/@ffmpeg-installer/**",
      "./node_modules/@ffprobe-installer/**",
      "./node_modules/@img/**",
      "./node_modules/sharp/**",
    ],
  },
  poweredByHeader: false,
};

export default nextConfig;
