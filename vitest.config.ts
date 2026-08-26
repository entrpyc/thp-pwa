import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
// Imported with its extension because Vite’s coming native config loader is Node’s own TypeScript
// support, which resolves no specifier a runtime would not — `allowImportingTsExtensions` in
// tsconfig.base.json is what lets `tsc` read the same line.
import { TEST_BIBLE } from './tests/setup/bible.ts';

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
          // The worker resolves passages **in this process**, so the suite’s verse settings have to
          // reach it here as well as reach the servers tests/setup/global.ts starts. Without them a
          // machine with no `.env` — CI — runs the draft step with no translation to hold a verse
          // under, and “the passage is held before the item is opened” quietly resolves nothing.
          env: { ...TEST_BIBLE },
          globalSetup: ['./tests/setup/global.ts'],
          testTimeout: 60_000,
          hookTimeout: 240_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
