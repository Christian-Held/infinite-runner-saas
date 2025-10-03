import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/api/vitest.config.ts',
  'services/playtester/vitest.config.ts',
  'packages/game-spec/vitest.config.ts',
  'apps/web/vitest.config.ts',
]);
