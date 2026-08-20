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
          include: ['tests/guards/**/*.test.ts', 'packages/*/tests/unit/**/*.test.ts'],
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
