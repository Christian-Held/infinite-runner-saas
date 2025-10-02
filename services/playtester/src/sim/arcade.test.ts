import assert from 'node:assert/strict';

import { LevelT } from '@ir/game-spec';

import {
  COYOTE_MS,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  createStepContext,
  step,
  type InputState,
  type PlayerState,
} from './arcade';

function buildTestLevel(): LevelT {
  return {
    id: 'wall-test',
    seed: 'wall-test',
    rules: {
      abilities: { run: true, jump: true },
      duration_target_s: 60,
      difficulty: 1,
    },
    tiles: [
      { x: 0, y: 0, w: 200, h: 32, type: 'ground' },
      { x: 100, y: -64, w: 20, h: 96, type: 'ground' },
    ],
    moving: [],
    items: [],
    enemies: [],
    checkpoints: [],
    exit: { x: 300, y: -32 },
  };
}

function createState(): PlayerState {
  return {
    frame: 0,
    x: 90,
    y: -PLAYER_HEIGHT,
    vx: 0,
    vy: 0,
    onGround: true,
    coyoteTimerMs: COYOTE_MS,
    jumpBufferMs: 0,
    shortFlyAvailable: true,
    jetpackFuel: 0,
    furthestX: 90,
  };
}

function createInput(): InputState {
  return { left: false, right: true, jump: false, fly: false, thrust: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const level = buildTestLevel();
  const context = createStepContext(level);
  const wall = level.tiles[1];
  let state = createState();
  const input = createInput();

  for (let i = 0; i < 10; i += 1) {
    const result = step(level, state, input, context);
    state = result.state;
  }

  const expectedX = wall.x - PLAYER_WIDTH;
  assert.ok(Math.abs(state.x - expectedX) < 1e-6);
  assert.equal(state.vx, 0);
  console.log('horizontal wall collision test: ok');
}
