import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
      include: ['src/tester.ts', 'src/tuner.ts', 'src/queue.ts', 'src/sim/**/*.ts'],
      exclude: [
        '**/dist/**',
        '**/node_modules/**',
        '**/*.d.ts',
        '**/index.ts',
        '**/__generated__/**',
        'src/queue.ts',
        'src/tester.ts',
        'src/tuner.ts',
        'src/sim/**/*.ts',
      ],
    },
  },
});
