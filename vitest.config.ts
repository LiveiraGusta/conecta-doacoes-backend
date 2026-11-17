import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: { provider: 'v8', include: ['src/**'] },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          env: { NODE_ENV: 'test' },
          setupFiles: ['test/helpers/load-env.ts'],
        },
      },
      {
        test: {
          name: 'int',
          include: ['test/**/*.test.ts'],
          setupFiles: ['test/helpers/load-env.ts'],
          globalSetup: ['test/helpers/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
