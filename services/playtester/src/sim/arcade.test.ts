import { describe, expect, it } from 'vitest';

import { LevelT } from '@ir/game-spec';

import { createSpawn, simulate } from './arcade';

const baseLevel: LevelT = {
  id: 'level-test',
  seed: 'seed',
  rules: {
    abilities: { run: true, jump: true },
    duration_target_s: 60,
    difficulty: 1,
  },
  tiles: [
    { x: 0, y: 200, w: 400, h: 20, type: 'ground' },
  ],
  moving: [],
  items: [],
  enemies: [],
  checkpoints: [],
  exit: { x: 320, y: 160 },
};

describe('sim/arcade', () => {
  it('computes a spawn point on the first ground tile', () => {
    const spawn = createSpawn(baseLevel);
    expect(spawn).not.toBeNull();
    expect(spawn).toEqual({ x: 24, y: 168 });
  });

  it('simulates a straightforward run to the exit', () => {
    const result = simulate(baseLevel, [{ t: 0, right: true }]);
    expect(result.ok).toBe(true);
    expect(result.frames).toBeGreaterThan(0);
  });
});
