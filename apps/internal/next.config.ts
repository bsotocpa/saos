import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The rendered-output harness builds into its own directory outside the repo (apps/e2e/
  // global-setup.ts sets NEXT_DIST_DIR), so its restarts never fight the developer's .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL ?? 'http://localhost:3001'}/:path*`,
      },
    ];
  },
};

export default nextConfig;
