import assert from 'node:assert/strict';

import { LevelT } from '@ir/game-spec';

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

function buildFail(details: Record<string, unknown>): Parameters<typeof tune>[1] {
  return {
    ok: false,
    reason: 'hazard_window_small',
    at: { x: 48, y: 0 },
    details,
  } as const;
}

function testAdjustsExistingWindow() {
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

  const fail = buildFail({ movingIndex: 0, minOpeningMs: 180, periodRange: [800, 1600] });
  const result = tune(level, fail);

  assert.ok(result, 'expected tune() to patch level');
  assert.equal(result?.patch.op, 'widen_hazard_window');
  const moving = result?.patched.moving?.[0];
  assert.ok(moving, 'expected moving platform to exist');
  assert.equal(moving.open_ms, 200);
  assert.equal(moving.period_ms, 800);
}

function testInitialisesMissingWindow() {
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

  const fail = buildFail({ movingIndex: 0, minOpeningMs: 260 });
  const result = tune(level, fail);

  assert.ok(result, 'expected tune() to patch level');
  const moving = result?.patched.moving?.[0];
  assert.ok(moving, 'expected moving platform to exist');
  assert.equal(moving.open_ms, 260);
  assert.equal(moving.period_ms, 1500);
}

function run() {
  testAdjustsExistingWindow();
  testInitialisesMissingWindow();
  console.log('tuner hazard window tests: ok');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}

export { run as runTunerHazardWindowTests };
