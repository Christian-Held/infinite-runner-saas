import { LevelT } from '@ir/game-spec';

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const INPUT_HZ = 30;
const INPUT_FRAME_INTERVAL = TICK_HZ / INPUT_HZ;

export const GRAVITY_Y = 1200;
export const MOVE_SPEED = 180;
export const JUMP_VY = -520;
export const COYOTE_MS = 90;
export const JUMPBUFFER_MS = 100;

export const PLAYER_WIDTH = 24;
export const PLAYER_HEIGHT = 32;

export type InputCmd = {
  t: number;
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  fly?: boolean;
  thrust?: boolean;
};

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
  furthestX: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface StepResult {
  state: PlayerState;
  collidedHazard: Rect | null;
}

export interface StepContext {
  abilities: LevelT['rules']['abilities'];
  ground: Rect[];
  platforms: Rect[];
  hazards: Rect[];
}

export interface SimResult {
  ok: boolean;
  frames: number;
  reason?: string;
  path: InputCmd[];
  fail?: {
    at: { x: number; y: number };
    hazard?: Rect;
  };
}

const WALKABLE_TYPES: LevelT['tiles'][number]['type'][] = ['ground', 'platform'];

function cloneState(state: PlayerState): PlayerState {
  return { ...state };
}

function defaultInput(): InputState {
  return { left: false, right: false, jump: false, fly: false, thrust: false };
}

function applyCommand(previous: InputState, command?: InputCmd): InputState {
  if (!command) {
    return { ...previous };
  }
  const next = { ...previous };
  if ('left' in command) {
    next.left = Boolean(command.left);
  }
  if ('right' in command) {
    next.right = Boolean(command.right);
  }
  if ('jump' in command) {
    next.jump = Boolean(command.jump);
  }
  if ('fly' in command) {
    next.fly = Boolean(command.fly);
  }
  if ('thrust' in command) {
    next.thrust = Boolean(command.thrust);
  }
  return next;
}

function mergeCommands(commands: InputCmd[]): InputCmd[] {
  const map = new Map<number, InputCmd>();
  for (const command of commands) {
    if (command.t < 0) {
      continue;
    }
    const existing = map.get(command.t) ?? { t: command.t };
    const merged: InputCmd = { ...existing };
    if ('left' in command) {
      merged.left = command.left;
    }
    if ('right' in command) {
      merged.right = command.right;
    }
    if ('jump' in command) {
      merged.jump = command.jump;
    }
    if ('fly' in command) {
      merged.fly = command.fly;
    }
    if ('thrust' in command) {
      merged.thrust = command.thrust;
    }
    map.set(command.t, merged);
  }
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

export function createStepContext(level: LevelT): StepContext {
  const ground: Rect[] = [];
  const platforms: Rect[] = [];
  const hazards: Rect[] = [];

  for (const tile of level.tiles) {
    if (tile.type === 'ground') {
      ground.push({ x: tile.x, y: tile.y, w: tile.w, h: tile.h });
    } else if (tile.type === 'platform') {
      platforms.push({ x: tile.x, y: tile.y, w: tile.w, h: tile.h });
    } else if (tile.type === 'hazard') {
      hazards.push({ x: tile.x, y: tile.y, w: tile.w, h: tile.h });
    }
  }

  return { abilities: level.rules.abilities, ground, platforms, hazards };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function createSpawn(level: LevelT): { x: number; y: number } | null {
  const walkable = level.tiles
    .filter((tile) => WALKABLE_TYPES.includes(tile.type))
    .sort((a, b) => a.x - b.x);

  const first = walkable[0];
  if (!first) {
    return null;
  }

  const spawnX = first.x + Math.min(Math.max(PLAYER_WIDTH, 16), first.w / 2);
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

  return {
    frame: 0,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    onGround: true,
    coyoteTimerMs: COYOTE_MS,
    jumpBufferMs: 0,
    shortFlyAvailable: true,
    jetpackFuel,
    furthestX: spawn.x,
  };
}

function verticalOverlap(y: number, h: number, tile: Rect): boolean {
  return y < tile.y + tile.h && y + h > tile.y;
}

function resolveHorizontalCollisions(
  previous: PlayerState,
  targetX: number,
  vx: number,
  ctx: StepContext,
): { x: number; vx: number } {
  if (vx === 0) {
    return { x: previous.x, vx: 0 };
  }

  const tiles = [...ctx.ground, ...ctx.platforms];
  const overlapping = tiles.filter((tile) => verticalOverlap(previous.y, PLAYER_HEIGHT, tile));
  let resolvedX = targetX;
  let resolvedVx = vx;

  if (vx > 0) {
    let minX = targetX;
    for (const tile of overlapping) {
      const prevRight = previous.x + PLAYER_WIDTH;
      const tileLeft = tile.x;
      if (prevRight <= tileLeft && targetX + PLAYER_WIDTH > tileLeft) {
        const candidate = tileLeft - PLAYER_WIDTH;
        if (candidate < minX) {
          minX = candidate;
        }
      } else if (
        rectsOverlap({ x: targetX, y: previous.y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT }, tile)
      ) {
        const candidate = tileLeft - PLAYER_WIDTH;
        if (candidate < minX) {
          minX = candidate;
        }
      }
    }
    if (minX < targetX) {
      resolvedX = minX;
      resolvedVx = 0;
    }
  } else {
    let maxX = targetX;
    for (const tile of overlapping) {
      const prevLeft = previous.x;
      const tileRight = tile.x + tile.w;
      if (prevLeft >= tileRight && targetX < tileRight) {
        const candidate = tileRight;
        if (candidate > maxX) {
          maxX = candidate;
        }
      } else if (
        rectsOverlap({ x: targetX, y: previous.y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT }, tile)
      ) {
        const candidate = tileRight;
        if (candidate > maxX) {
          maxX = candidate;
        }
      }
    }
    if (maxX > targetX) {
      resolvedX = maxX;
      resolvedVx = 0;
    }
  }

  return { x: resolvedX, vx: resolvedVx };
}

function resolveVerticalCollisions(
  previous: PlayerState,
  targetY: number,
  currentX: number,
  vy: number,
  ctx: StepContext,
): { y: number; vy: number; onGround: boolean } {
  let resolvedY = targetY;
  let resolvedVy = vy;
  let onGround = false;

  const playerRect = (y: number): Rect => ({ x: currentX, y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT });

  if (vy > 0) {
    let landingY = targetY;
    let landed = false;
    for (const tile of [...ctx.ground, ...ctx.platforms]) {
      if (!rectsOverlap(playerRect(targetY), tile)) {
        continue;
      }
      const prevBottom = previous.y + PLAYER_HEIGHT;
      const nextBottom = targetY + PLAYER_HEIGHT;
      const tileTop = tile.y;
      if (prevBottom > tileTop + 0.01) {
        continue;
      }
      if (nextBottom < tileTop) {
        continue;
      }
      const candidate = tileTop - PLAYER_HEIGHT;
      if (!landed || candidate < landingY) {
        landingY = candidate;
        landed = true;
      }
    }
    if (landed) {
      resolvedY = landingY;
      resolvedVy = 0;
      onGround = true;
    }
  } else if (vy < 0) {
    let ceilingY = targetY;
    let bumped = false;
    for (const tile of ctx.ground) {
      if (!rectsOverlap(playerRect(targetY), tile)) {
        continue;
      }
      const prevTop = previous.y;
      const nextTop = targetY;
      const tileBottom = tile.y + tile.h;
      if (prevTop < tileBottom - 0.01) {
        continue;
      }
      if (nextTop > tileBottom) {
        continue;
      }
      const candidate = tileBottom;
      if (!bumped || candidate > ceilingY) {
        ceilingY = candidate;
        bumped = true;
      }
    }
    if (bumped) {
      resolvedY = ceilingY;
      resolvedVy = 0;
    }
  }

  return { y: resolvedY, vy: resolvedVy, onGround };
}

function applyJump(
  previous: PlayerState,
  next: PlayerState,
  ctx: StepContext,
  useHighJump: boolean,
): void {
  const base = useHighJump ? JUMP_VY * 1.2 : JUMP_VY;
  next.vy = base;
  next.onGround = false;
  next.coyoteTimerMs = 0;
  next.jumpBufferMs = 0;
}

function applyShortFly(
  previous: PlayerState,
  next: PlayerState,
  ctx: StepContext,
  input: InputState,
): void {
  if (!ctx.abilities.shortFly) {
    return;
  }
  if (previous.onGround || !input.fly || !previous.shortFlyAvailable) {
    return;
  }
  next.vy = Math.min(next.vy, JUMP_VY * 0.6);
  next.shortFlyAvailable = false;
}

function applyJetpack(
  previous: PlayerState,
  next: PlayerState,
  ctx: StepContext,
  input: InputState,
): void {
  if (!ctx.abilities.jetpack || !input.thrust || previous.jetpackFuel <= 0) {
    next.jetpackFuel = previous.jetpackFuel;
    return;
  }
  next.vy += ctx.abilities.jetpack.thrust * DT;
  next.jetpackFuel = Math.max(0, previous.jetpackFuel - 1);
}

export function step(
  level: LevelT,
  state: PlayerState,
  input: InputState,
  context?: StepContext,
): StepResult {
  const ctx = context ?? createStepContext(level);
  const previous = cloneState(state);
  const next = cloneState(state);
  next.frame = state.frame + 1;

  const wantsLeft = input.left && !input.right;
  const wantsRight = input.right && !input.left;
  if (wantsLeft === wantsRight) {
    next.vx = 0;
  } else {
    next.vx = wantsLeft ? -MOVE_SPEED : MOVE_SPEED;
  }

  if (previous.onGround) {
    next.coyoteTimerMs = COYOTE_MS;
    next.shortFlyAvailable = true;
  } else {
    next.coyoteTimerMs = Math.max(0, previous.coyoteTimerMs - DT * 1000);
    next.shortFlyAvailable = previous.shortFlyAvailable;
  }

  if (input.jump) {
    next.jumpBufferMs = JUMPBUFFER_MS;
  } else {
    next.jumpBufferMs = Math.max(0, previous.jumpBufferMs - DT * 1000);
  }

  next.jetpackFuel = previous.jetpackFuel;
  next.onGround = previous.onGround;
  next.vy = previous.vy;

  const canJump = (previous.onGround || previous.coyoteTimerMs > 0) && next.jumpBufferMs > 0;
  if (canJump) {
    const useHighJump = Boolean(ctx.abilities.highJump);
    applyJump(previous, next, ctx, useHighJump);
  }

  applyShortFly(previous, next, ctx, input);
  applyJetpack(previous, next, ctx, input);

  const horizontalTargetX = previous.x + next.vx * DT;
  const horizontalResult = resolveHorizontalCollisions(previous, horizontalTargetX, next.vx, ctx);
  next.x = horizontalResult.x;
  next.vx = horizontalResult.vx;

  next.vy += GRAVITY_Y * DT;

  const verticalTargetY = previous.y + next.vy * DT;
  const verticalResult = resolveVerticalCollisions(previous, verticalTargetY, next.x, next.vy, ctx);
  next.y = verticalResult.y;
  next.vy = verticalResult.vy;
  next.onGround = verticalResult.onGround;

  if (next.onGround) {
    next.coyoteTimerMs = COYOTE_MS;
    next.shortFlyAvailable = true;
  }

  next.furthestX = Math.max(previous.furthestX, next.x);

  const playerRect: Rect = { x: next.x, y: next.y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT };
  const collidedHazard = ctx.hazards.find((hazard) => rectsOverlap(playerRect, hazard)) ?? null;

  return { state: next, collidedHazard };
}

function buildExitRect(level: LevelT): Rect {
  return {
    x: level.exit.x - PLAYER_WIDTH,
    y: level.exit.y - PLAYER_HEIGHT,
    w: PLAYER_WIDTH * 2,
    h: PLAYER_HEIGHT * 2,
  };
}

function compressExecuted(commands: InputCmd[]): InputCmd[] {
  const result: InputCmd[] = [];
  const sorted = mergeCommands(commands);
  let prevState = defaultInput();

  for (const command of sorted) {
    const nextState = applyCommand(prevState, command);
    const delta: InputCmd = { t: command.t };
    let changed = false;

    (['left', 'right', 'jump', 'fly', 'thrust'] as const).forEach((key) => {
      if (prevState[key] !== nextState[key]) {
        delta[key] = nextState[key];
        changed = true;
      }
    });

    if (changed || command.t === 0) {
      result.push(delta);
    }
    prevState = nextState;
  }

  return result;
}

export function simulate(level: LevelT, inputs: InputCmd[]): SimResult {
  const baseState = initialPlayerState(level);
  if (!baseState) {
    return {
      ok: false,
      reason: 'no_spawn',
      frames: 0,
      path: [],
      fail: { at: { x: 0, y: level.exit.y } },
    };
  }

  const commands = mergeCommands(inputs);
  const applied: InputCmd[] = [];
  const context = createStepContext(level);
  const exitRect = buildExitRect(level);

  let state = cloneState(baseState);
  let inputState = defaultInput();
  let commandIndex = 0;
  let nextCommand = commands[commandIndex];
  const maxFrames = Math.max(3600, Math.floor((level.rules.duration_target_s ?? 60) * TICK_HZ * 2));

  for (let frame = 0; frame < maxFrames; frame += 1) {
    if (frame % INPUT_FRAME_INTERVAL === 0) {
      const inputFrame = frame / INPUT_FRAME_INTERVAL;
      while (nextCommand && nextCommand.t <= inputFrame) {
        inputState = applyCommand(inputState, nextCommand);
        applied.push({ ...nextCommand });
        commandIndex += 1;
        nextCommand = commands[commandIndex];
      }
    }

    const { state: nextState, collidedHazard } = step(level, state, inputState, context);
    state = nextState;

    const playerRect: Rect = { x: state.x, y: state.y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT };
    if (rectsOverlap(playerRect, exitRect)) {
      return { ok: true, frames: state.frame, path: compressExecuted(applied) };
    }

    if (collidedHazard) {
      return {
        ok: false,
        frames: state.frame,
        reason: 'hazard',
        path: compressExecuted(applied),
        fail: { at: { x: state.x, y: state.y }, hazard: collidedHazard },
      };
    }
  }

  return {
    ok: false,
    frames: state.frame,
    reason: 'timeout',
    path: compressExecuted(applied),
    fail: { at: { x: state.x, y: state.y } },
  };
}

export function maxJumpGapPX(highJump = false): number {
  const jumpVelocity = highJump ? JUMP_VY * 1.2 : JUMP_VY;
  const timeUp = Math.abs(jumpVelocity) / GRAVITY_Y;
  const totalTime = timeUp * 2;
  return MOVE_SPEED * totalTime;
}
