import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Local runs read the git-ignored repository .env. Deployments set the variables directly.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The foundation and the contracts are TypeScript source packages.
  transpilePackages: ['@lathe/application-foundation', '@lathe/shared-contracts'],
  // Those packages import `./x.js` for `./x.ts` (NodeNext). Turbopack does not map the
  // extension, so the app builds with webpack (`--webpack` in package.json) and this alias.
  webpack: (webpackConfig: { resolve: { extensionAlias?: Record<string, string[]> } }) => {
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return webpackConfig;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default config;
