import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
      exclude: [
        '**/dist/**',
        '**/node_modules/**',
        '**/*.d.ts',
        '**/index.ts',
        '**/__generated__/**',
        'src/main.ts',
        'src/game/**',
        'src/level/**',
        'src/scenes/**',
        'src/types/**',
      ],
    },
  },
});
