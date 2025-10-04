import { describe, expect, it } from 'vitest';

import { LevelT } from '@ir/game-spec';

import type { Logger } from '@pkg/logger';

import { tune } from './tuner';

type PartialLevel = Partial<Omit<LevelT, 'rules'>> & {
  rules?: Partial<LevelT['rules']> & { abilities?: Partial<LevelT['rules']['abilities']> };
};

function createLevel(partial: PartialLevel = {}): LevelT {
  return {
    id: 'level-test',
    seed: 'seed-test',
    rules: {
      abilities: { run: true, jump: true, ...(partial.rules?.abilities ?? {}) },
      duration_target_s: partial.rules?.duration_target_s ?? 60,
      difficulty: partial.rules?.difficulty ?? 1,
    },
    tiles: partial.tiles ?? [],
    moving: partial.moving ?? [],
    items: partial.items ?? [],
    enemies: partial.enemies ?? [],
    checkpoints: partial.checkpoints ?? [],
    exit: partial.exit ?? { x: 100, y: 0 },
  };
}

const baseLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  fatal: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => baseLogger,
};
const logger = baseLogger as unknown as Logger;

describe('tuner', () => {
  it('adjusts an existing hazard window to meet requirements', () => {
    const level = createLevel({
      moving: [
        {
          id: 'moving-1',
          from: [0, 0],
          to: [96, 0],
          period_ms: 620,
          phase: 0,
          open_ms: 120,
        },
      ],
    });

    const fail = {
      ok: false,
      reason: 'hazard_window_small' as const,
      at: { x: 48, y: 0 },
      details: { movingIndex: 0, minOpeningMs: 180, periodRange: [800, 1600] },
    };
    const result = tune(level, fail, logger);

    expect(result).not.toBeNull();
    expect(result?.patch.op).toBe('widen_hazard_window');
    const moving = result?.patched.moving?.[0];
    expect(moving?.open_ms).toBe(200);
    expect(moving?.period_ms).toBe(800);
  });

  it('initialises a missing hazard window with sensible defaults', () => {
    const level = createLevel({
      moving: [
        {
          id: 'moving-2',
          from: [0, 0],
          to: [0, -96],
          period_ms: 1500,
          phase: 0.5,
        },
      ],
    });

    const fail = {
      ok: false,
      reason: 'hazard_window_small' as const,
      at: { x: 0, y: 0 },
      details: { movingIndex: 0, minOpeningMs: 260 },
    };
    const result = tune(level, fail, logger);

    expect(result).not.toBeNull();
    const moving = result?.patched.moving?.[0];
    expect(moving?.open_ms).toBe(260);
    expect(moving?.period_ms).toBe(1500);
  });

  it('shifts hazard tiles downward when provided in fail details', () => {
    const level = createLevel({
      tiles: [
        { x: 0, y: 200, w: 200, h: 20, type: 'ground' },
        { x: 80, y: 180, w: 40, h: 20, type: 'hazard' },
      ],
    });

    const fail = {
      ok: false,
      reason: 'hazard_no_window' as const,
      at: { x: 90, y: 180 },
      details: {
        hazard: {
          tileIndex: 1,
          tile: { x: 80, y: 180, w: 40, h: 20, type: 'hazard' as const },
        },
      },
    };

    const result = tune(level, fail, logger);
    expect(result).not.toBeNull();
    expect(result?.patch.op).toBe('shift_hazard');
    const tile = result?.patched.tiles[1];
    expect(tile.type).toBe('hazard');
    expect(tile.y).toBe(188);
  });
});
