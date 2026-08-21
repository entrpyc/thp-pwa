import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages ship TypeScript source rather than a build artefact.
  transpilePackages: ['@thp/shared', '@thp/db'],
  typedRoutes: false,
  serverExternalPackages: ['postgres', '@node-rs/argon2'],
};

export default config;
