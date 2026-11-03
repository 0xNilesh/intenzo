import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Next 16 writes an AGENTS.md into the app on `next dev`; this repo has its own.
  agentRules: false,
};

export default nextConfig;
