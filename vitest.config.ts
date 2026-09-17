import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against package sources directly, so no build step is required
    // before `pnpm test`. Order matters: longer paths first.
    alias: [
      { find: '@eapp/transport-memory', replacement: pkg('./packages/transport/memory/src/index.ts') },
      { find: '@eapp/transport-socket', replacement: pkg('./packages/transport/socket/src/index.ts') },
      { find: '@eapp/interaction', replacement: pkg('./packages/interaction/src/index.ts') },
      { find: '@eapp/runtime', replacement: pkg('./packages/runtime/src/index.ts') },
      { find: '@eapp/state', replacement: pkg('./packages/state/src/index.ts') },
      { find: '@eapp/core', replacement: pkg('./packages/core/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
