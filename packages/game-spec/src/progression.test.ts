import { describe, expect, it } from 'vitest';

import { getLevelPlan } from './progression';

describe('progression', () => {
  it('returns base abilities and constraints for early levels', () => {
    const plan = getLevelPlan(5);
    expect(plan.levelNumber).toBe(5);
    expect(plan.abilities.run).toBe(true);
    expect(plan.abilities.highJump).toBeUndefined();
    expect(plan.constraints.maxGapPX).toBeGreaterThan(0);
    expect(plan.difficultyBand).toEqual([1, 10]);
  });

  it('unlocks advanced abilities and clamps level bounds', () => {
    const plan = getLevelPlan(150);
    expect(plan.levelNumber).toBe(100);
    expect(plan.abilities.shortFly).toBe(true);
    expect(plan.abilities.jetpack).toMatchObject({ fuel: expect.any(Number), thrust: 640 });
    expect(plan.constraints.jetpack).toMatchObject({ fuel: expect.any(Number), thrust: 640 });
    expect(plan.difficultyBand).toEqual([81, 100]);
  });

  it('normalises invalid levels to the first band', () => {
    const plan = getLevelPlan(Number.NaN);
    expect(plan.levelNumber).toBe(1);
    expect(plan.difficultyBand).toEqual([1, 10]);
  });

  it('progresses constraint bands across the journey', () => {
    const samples: Array<{ level: number; band: [number, number] }> = [
      { level: 20, band: [11, 30] },
      { level: 35, band: [31, 40] },
      { level: 55, band: [41, 60] },
      { level: 75, band: [61, 80] },
    ];

    for (const sample of samples) {
      const plan = getLevelPlan(sample.level);
      expect(plan.difficultyBand).toEqual(sample.band);
      expect(plan.constraints.movingMax).toBeGreaterThanOrEqual(0);
      expect(plan.constraints.enemyMax).toBeGreaterThanOrEqual(0);
      expect(plan.constraints.hazardMax).toBeGreaterThanOrEqual(0);
    }
  });
});
