import { describe, expect, it } from 'vitest';

import { LevelT } from '@ir/game-spec';

import { findPath } from './search';

const simpleLevel: LevelT = {
  id: 'path-test',
  seed: 'seed',
  rules: {
    abilities: { run: true, jump: true },
    duration_target_s: 60,
    difficulty: 1,
  },
  tiles: [
    { x: 0, y: 200, w: 400, h: 20, type: 'ground' },
    { x: 420, y: 200, w: 200, h: 20, type: 'ground' },
  ],
  moving: [],
  items: [],
  enemies: [],
  checkpoints: [],
  exit: { x: 500, y: 160 },
};

describe('sim/search', () => {
  it('finds a path across simple ground tiles', () => {
    const result = findPath(simpleLevel, 500, 2000);
    expect(result.ok).toBe(true);
    expect(result.path?.length ?? 0).toBeGreaterThan(0);
  });
});
