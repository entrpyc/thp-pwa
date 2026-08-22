import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const webSrc = resolve(import.meta.dirname, 'packages/web/src');

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { '@': webSrc } },
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'tests/guards/**/*.test.ts',
            // Repository-level unit tests that belong to no package — the deployment scripts under
            // scripts/, whose parsers are the only part of them a test can reach.
            'tests/unit/**/*.test.ts',
            'packages/*/tests/unit/**/*.test.ts',
          ],
        },
      },
      {
        resolve: { alias: { '@': webSrc } },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['packages/*/tests/integration/**/*.test.ts'],
          globalSetup: ['./tests/setup/global.ts'],
          testTimeout: 60_000,
          hookTimeout: 240_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
