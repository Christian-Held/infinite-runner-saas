import { LevelT } from '@ir/game-spec';

export const DT = 1 / 60;
export const GRAVITY_Y = 1200;
export const MOVE_SPEED = 180;
export const JUMP_VY = -520;
export const COYOTE_MS = 90;
export const JUMPBUFFER_MS = 100;

export const PLAYER_WIDTH = 24;
export const PLAYER_HEIGHT = 32;

export type GridHash = Set<string>;

export interface InputCmd {
  t: number;
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  fly?: boolean;
  thrust?: boolean;
}

export interface InputState {
  left: boolean;
  right: boolean;
  jump: boolean;
  fly: boolean;
  thrust: boolean;
}

export interface PlayerState {
  frame: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  coyoteTimerMs: number;
  jumpBufferMs: number;
  shortFlyAvailable: boolean;
  jetpackFuel: number;
}

export interface StepContext {
  abilities: LevelT['rules']['abilities'];
  tiles: LevelT['tiles'];
  hazards: LevelT['tiles'];
}

export interface StepResult extends PlayerState {
  collidedHazard: boolean;
  terminated: boolean;
}

export interface SpawnInfo {
  x: number;
  y: number;
}

export interface SimResult {
  ok: boolean;
  reason?: string;
  frames: number;
  x: number;
  y: number;
  visited: GridHash;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normaliseInput(input?: InputCmd): InputState {
  return {
    left: Boolean(input?.left),
    right: Boolean(input?.right),
    jump: Boolean(input?.jump),
    fly: Boolean(input?.fly),
    thrust: Boolean(input?.thrust),
  };
}

function quantisePosition(value: number): number {
  return Math.round(value / 2) * 2;
}

export function createSpawn(level: LevelT): SpawnInfo | null {
  const walkable = level.tiles
    .filter((tile) => tile.type === 'ground' || tile.type === 'platform')
    .sort((a, b) => a.x - b.x);

  const first = walkable[0];
  if (!first) {
    return null;
  }

  const spawnX = first.x + Math.min(32, Math.max(8, PLAYER_WIDTH));
  const spawnY = first.y - PLAYER_HEIGHT;

  return { x: spawnX, y: spawnY };
}

export function initialPlayerState(level: LevelT): PlayerState | null {
  const spawn = createSpawn(level);
  if (!spawn) {
    return null;
  }

  const abilities = level.rules.abilities;
  const jetpackFuel = abilities.jetpack ? abilities.jetpack.fuel : 0;

  const tiles = level.tiles.filter((tile) => tile.type === 'ground' || tile.type === 'platform');
  const playerRect: Rect = { x: spawn.x, y: spawn.y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT };
  const onGround = tiles.some((tile) => {
    const isBelow = Math.abs(playerRect.y + playerRect.h - tile.y) <= 1;
    const horizontalOverlap = playerRect.x + playerRect.w > tile.x && playerRect.x < tile.x + tile.w;
    return isBelow && horizontalOverlap;
  });

  return {
    frame: 0,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    onGround,
    coyoteTimerMs: 0,
    jumpBufferMs: 0,
    shortFlyAvailable: true,
    jetpackFuel,
  };
}

function resolveHorizontalCollisions(state: PlayerState, tiles: Rect[]): void {
  if (state.vx === 0) {
    return;
  }

  const nextX = state.x + state.vx * DT;
  const playerRect: Rect = { x: nextX, y: state.y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT };

  for (const tile of tiles) {
    if (rectsOverlap(playerRect, tile)) {
      if (state.vx > 0) {
        playerRect.x = tile.x - PLAYER_WIDTH;
      } else if (state.vx < 0) {
        playerRect.x = tile.x + tile.w;
      }
      state.vx = 0;
    }
  }

  state.x = playerRect.x;
}

function resolveVerticalCollisions(state: PlayerState, tiles: Rect[]): void {
  const nextY = state.y + state.vy * DT;
  const playerRect: Rect = { x: state.x, y: nextY, w: PLAYER_WIDTH, h: PLAYER_HEIGHT };

  let onGround = false;

  for (const tile of tiles) {
    if (!rectsOverlap(playerRect, tile)) {
      continue;
    }

    if (state.vy > 0) {
      playerRect.y = tile.y - PLAYER_HEIGHT;
      state.vy = 0;
      onGround = true;
    } else if (state.vy < 0) {
      playerRect.y = tile.y + tile.h;
      state.vy = 0;
    }
  }

  state.y = playerRect.y;
  state.onGround = onGround;
}

function applyJump(state: PlayerState, abilities: LevelT['rules']['abilities']): void {
  if (state.jumpBufferMs <= 0) {
    return;
  }
  if (!state.onGround && state.coyoteTimerMs <= 0) {
    return;
  }

  const jumpStrength = abilities.highJump ? JUMP_VY * 1.2 : JUMP_VY;

  state.vy = jumpStrength;
  state.onGround = false;
  state.coyoteTimerMs = 0;
  state.jumpBufferMs = 0;
  if (abilities.shortFly) {
    state.shortFlyAvailable = false;
  }
}

function applyShortFly(state: PlayerState, abilities: LevelT['rules']['abilities'], input: InputState): void {
  if (!abilities.shortFly) {
    return;
  }
  if (!input.fly || state.onGround || !state.shortFlyAvailable) {
    return;
  }

  state.vy = Math.min(state.vy, JUMP_VY * 0.6);
  state.shortFlyAvailable = false;
}

function applyJetpack(state: PlayerState, abilities: LevelT['rules']['abilities'], input: InputState): void {
  if (!abilities.jetpack) {
    return;
  }
  if (!input.thrust || state.jetpackFuel <= 0) {
    return;
  }

  const thrust = abilities.jetpack.thrust;
  state.vy += thrust * DT;
  state.jetpackFuel = clamp(state.jetpackFuel - 1, 0, abilities.jetpack.fuel);
}

export function step(level: LevelT, previousState: PlayerState, rawInput: InputCmd | InputState): StepResult {
  const abilities = level.rules.abilities;
  const tiles = level.tiles.filter((tile) => tile.type === 'ground' || tile.type === 'platform');
  const hazards = level.tiles.filter((tile) => tile.type === 'hazard');

  const input = 'left' in rawInput ? (rawInput as InputState) : normaliseInput(rawInput as InputCmd);
  const next: PlayerState = {
    ...previousState,
    frame: previousState.frame + 1,
    x: previousState.x,
    y: previousState.y,
    vx: 0,
    vy: previousState.vy,
    onGround: previousState.onGround,
    coyoteTimerMs: previousState.coyoteTimerMs,
    jumpBufferMs: previousState.jumpBufferMs,
    shortFlyAvailable: previousState.shortFlyAvailable,
    jetpackFuel: previousState.jetpackFuel,
  };

  next.vx = input.left === input.right ? 0 : input.left ? -MOVE_SPEED : MOVE_SPEED;

  if (next.onGround) {
    next.coyoteTimerMs = COYOTE_MS;
    next.shortFlyAvailable = true;
  } else {
    next.coyoteTimerMs = Math.max(0, next.coyoteTimerMs - DT * 1000);
  }

  if (input.jump) {
    next.jumpBufferMs = JUMPBUFFER_MS;
  } else {
    next.jumpBufferMs = Math.max(0, next.jumpBufferMs - DT * 1000);
  }

  applyJump(next, abilities);
  applyShortFly(next, abilities, input);
  applyJetpack(next, abilities, input);

  next.vy += GRAVITY_Y * DT;

  resolveHorizontalCollisions(next, tiles);
  resolveVerticalCollisions(next, tiles);

  const playerRect: Rect = { x: next.x, y: next.y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT };
  const collidedHazard = hazards.some((hazard) => rectsOverlap(playerRect, hazard));

  return {
    ...next,
    collidedHazard,
    terminated: false,
  };
}

export function simulate(level: LevelT, inputs: InputCmd[]): SimResult {
  const baseState = initialPlayerState(level);
  if (!baseState) {
    return { ok: false, reason: 'no_spawn', frames: 0, x: 0, y: 0, visited: new Set() };
  }

  const visited: GridHash = new Set();
  const sortedInputs = [...inputs].sort((a, b) => a.t - b.t);
  let currentInput: InputState = normaliseInput(sortedInputs[0]);
  if (sortedInputs.length === 0) {
    currentInput = normaliseInput();
  }
  let nextCmdIndex = 1;

  let state: PlayerState = { ...baseState };
  let frame = 0;

  const maxFrame = (sortedInputs.at(-1)?.t ?? 0) * 2 + 600;

  const hazards = level.tiles.filter((tile) => tile.type === 'hazard');
  const exitRect: Rect = { x: level.exit.x - 16, y: level.exit.y - 48, w: 32, h: 48 };

  while (frame < maxFrame) {
    const inputFrame = Math.floor(frame / 2);
    if (nextCmdIndex < sortedInputs.length && sortedInputs[nextCmdIndex].t <= inputFrame) {
      currentInput = normaliseInput(sortedInputs[nextCmdIndex]);
      nextCmdIndex += 1;
    }

    const result = step(level, state, currentInput);
    state = result;

    const key = `${Math.floor(state.frame / 2)}:${quantisePosition(state.x)}:${quantisePosition(state.y)}`;
    visited.add(key);

    const playerRect: Rect = { x: state.x, y: state.y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT };
    if (rectsOverlap(playerRect, exitRect)) {
      return { ok: true, frames: state.frame, x: state.x, y: state.y, visited };
    }

    if (result.collidedHazard || hazards.some((hazard) => rectsOverlap(playerRect, hazard))) {
      return { ok: false, reason: 'hazard', frames: state.frame, x: state.x, y: state.y, visited };
    }

    frame += 1;
  }

  return { ok: false, reason: 'timeout', frames: state.frame, x: state.x, y: state.y, visited };
}

export function maxJumpGapPX(highJump = false): number {
  const jumpVelocity = highJump ? JUMP_VY * 1.2 : JUMP_VY;
  const timeUp = Math.abs(jumpVelocity) / GRAVITY_Y;
  const totalTime = timeUp * 2;
  return MOVE_SPEED * totalTime;
}
