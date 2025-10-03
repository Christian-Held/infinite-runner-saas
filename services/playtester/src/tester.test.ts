import { afterEach, describe, expect, it, vi } from 'vitest';

import { LevelT } from '@ir/game-spec';
import type { Logger } from '@ir/logger';

const hazardLevel: LevelT = {
  id: 'hazard-test',
  seed: 'hazard',
  rules: {
    abilities: { run: true, jump: true },
    duration_target_s: 60,
    difficulty: 1,
  },
  tiles: [
    { x: 0, y: 200, w: 400, h: 20, type: 'ground' },
    { x: 180, y: 180, w: 32, h: 20, type: 'hazard' },
    { x: 260, y: 180, w: 32, h: 20, type: 'hazard' },
  ],
  moving: [],
  items: [],
  enemies: [],
  checkpoints: [],
  exit: { x: 340, y: 160 },
};

describe('tester helpers', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    try {
      vi.unmock('./sim/arcade');
      vi.unmock('./sim/search');
    } catch {
      // Modules may not have been mocked in the preceding test.
    }
  });

  it('locates the closest hazard tile near a collision rect', async () => {
    const { findHazardNear } = await import('./tester');
    const rect = { x: 250, y: 176, w: 24, h: 24 };
    const hazard = findHazardNear(hazardLevel, rect);
    expect(hazard).not.toBeNull();
    expect(hazard?.tileIndex).toBe(2);
    expect(hazard?.tile.type).toBe('hazard');
  });

  it('includes hazard details on hazard failures', async () => {
    vi.doMock('./sim/search', async () => {
      const actual = await vi.importActual<typeof import('./sim/search')>('./sim/search');
      return {
        ...actual,
        findPath: () => ({ ok: true as const, path: [], nodes: 12, ms: 4 }),
      };
    });

    vi.doMock('./sim/arcade', async () => {
      const actual = await vi.importActual<typeof import('./sim/arcade')>('./sim/arcade');
      return {
        ...actual,
        simulate: () => ({
          ok: false as const,
          reason: 'hazard' as const,
          fail: {
            at: { x: 196, y: 180 },
            hazard: { x: 180, y: 180, w: 32, h: 20 },
          },
        }),
      };
    });

    const { testLevel } = await import('./tester');
    const baseLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
      child: () => baseLogger,
    };
    const logger = baseLogger as unknown as Logger;

    const result = await testLevel(hazardLevel, logger);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('hazard_no_window');
    expect(result.fail?.details && typeof result.fail.details === 'object').toBe(true);
    const details = result.fail?.details as { hazard?: { tileIndex: number } };
    expect(details.hazard?.tileIndex).toBe(1);
  });
});
