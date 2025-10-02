import { LevelT } from '@ir/game-spec';

import {
  INPUT_HZ,
  MOVE_SPEED,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  InputCmd,
  InputState,
  PlayerState,
  createStepContext,
  initialPlayerState,
  maxJumpGapPX,
  step,
} from './arcade';

const ACTION_FRAMES = 2;

interface Action {
  name: string;
  input: InputState;
}

interface SearchNode {
  state: PlayerState;
  g: number;
  h: number;
  f: number;
  parent?: SearchNode;
  action?: Action;
  key: string;
  direction: number;
  stalled: number;
}

interface GapInfo {
  fromX: number;
  toX: number;
  gap: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

class PriorityQueue<T extends { f: number }> {
  private heap: T[] = [];

  push(item: T): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) {
      return undefined;
    }
    const top = this.heap[0];
    const end = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = end;
      this.bubbleDown(0);
    }
    return top;
  }

  get length(): number {
    return this.heap.length;
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.heap[parent].f <= this.heap[current].f) {
        break;
      }
      [this.heap[parent], this.heap[current]] = [this.heap[current], this.heap[parent]];
      current = parent;
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    const length = this.heap.length;
    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let smallest = current;

      if (left < length && this.heap[left].f < this.heap[smallest].f) {
        smallest = left;
      }
      if (right < length && this.heap[right].f < this.heap[smallest].f) {
        smallest = right;
      }
      if (smallest === current) {
        break;
      }
      [this.heap[current], this.heap[smallest]] = [this.heap[smallest], this.heap[current]];
      current = smallest;
    }
  }
}

function defaultInput(): InputState {
  return { left: false, right: false, jump: false, fly: false, thrust: false };
}

function toInputState(partial: Partial<InputState>): InputState {
  return {
    left: Boolean(partial.left),
    right: Boolean(partial.right),
    jump: Boolean(partial.jump),
    fly: Boolean(partial.fly),
    thrust: Boolean(partial.thrust),
  };
}

function buildActions(level: LevelT): Action[] {
  const actions: Action[] = [
    { name: 'idle', input: toInputState({}) },
    { name: 'left', input: toInputState({ left: true }) },
    { name: 'right', input: toInputState({ right: true }) },
    { name: 'jump', input: toInputState({ jump: true }) },
    { name: 'left_jump', input: toInputState({ left: true, jump: true }) },
    { name: 'right_jump', input: toInputState({ right: true, jump: true }) },
  ];

  if (level.rules.abilities.shortFly) {
    actions.push({ name: 'fly', input: toInputState({ fly: true }) });
    actions.push({ name: 'fly_right', input: toInputState({ right: true, fly: true }) });
    actions.push({ name: 'fly_left', input: toInputState({ left: true, fly: true }) });
  }

  if (level.rules.abilities.jetpack) {
    actions.push({ name: 'thrust', input: toInputState({ thrust: true }) });
    actions.push({ name: 'thrust_right', input: toInputState({ right: true, thrust: true }) });
    actions.push({ name: 'thrust_left', input: toInputState({ left: true, thrust: true }) });
  }

  return actions;
}

function quantise(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function computeAbilityMask(level: LevelT): number {
  let mask = 0;
  if (level.rules.abilities.highJump) {
    mask |= 1;
  }
  if (level.rules.abilities.shortFly) {
    mask |= 2;
  }
  if (level.rules.abilities.jetpack) {
    mask |= 4;
  }
  return mask;
}

function stateKey(state: PlayerState, abilityMask: number): string {
  const x = quantise(state.x, 2);
  const y = quantise(state.y, 2);
  const vx = quantise(state.vx, 2);
  const vy = quantise(state.vy, 2);
  const onGround = state.onGround ? 1 : 0;
  const fly = state.shortFlyAvailable ? 1 : 0;
  const fuel = Math.round(state.jetpackFuel);
  const framePhase = state.frame % (INPUT_HZ * 8);
  return `${x}|${y}|${vx}|${vy}|${onGround}|${fly}|${fuel}|${framePhase}|${abilityMask}`;
}

function heuristic(state: PlayerState, exitX: number): number {
  const dx = Math.max(0, exitX - state.x);
  return (dx / MOVE_SPEED) * INPUT_HZ;
}

function advance(level: LevelT, context: ReturnType<typeof createStepContext>, state: PlayerState, input: InputState) {
  let current = state;
  let hazard = false;
  for (let i = 0; i < ACTION_FRAMES; i += 1) {
    const { state: next, collidedHazard } = step(level, current, input, context);
    current = next;
    hazard ||= collidedHazard;
  }
  return { next: current, hazard };
}

function computeWorldHeight(level: LevelT): number {
  const tileMax = level.tiles.reduce((max, tile) => Math.max(max, tile.y + tile.h), 0);
  return Math.max(tileMax, level.exit.y + PLAYER_HEIGHT);
}

function buildGapMap(level: LevelT): GapInfo[] {
  const walkable = level.tiles
    .filter((tile) => tile.type === 'ground' || tile.type === 'platform')
    .sort((a, b) => a.x - b.x);

  const gaps: GapInfo[] = [];
  for (let i = 0; i < walkable.length - 1; i += 1) {
    const current = walkable[i];
    const next = walkable[i + 1];
    const gap = next.x - (current.x + current.w);
    if (gap > 0) {
      gaps.push({ fromX: current.x + current.w, toX: next.x, gap, y: current.y });
    }
  }
  return gaps;
}

function violatesGap(state: PlayerState, gaps: GapInfo[], maxGap: number, allowFlight: boolean): boolean {
  if (allowFlight) {
    return false;
  }
  const playerBottom = state.y + PLAYER_HEIGHT;
  for (const gap of gaps) {
    if (gap.gap <= maxGap) {
      continue;
    }
    if (state.x + PLAYER_WIDTH < gap.fromX - 12) {
      continue;
    }
    if (state.x > gap.toX + 12) {
      continue;
    }
    const verticalAligned = playerBottom <= gap.y + PLAYER_HEIGHT && playerBottom >= gap.y - PLAYER_HEIGHT * 2;
    if (verticalAligned && state.x < gap.toX) {
      return true;
    }
  }
  return false;
}

function directionFor(input: InputState): number {
  if (input.left && !input.right) {
    return -1;
  }
  if (input.right && !input.left) {
    return 1;
  }
  return 0;
}

function buildExitRect(level: LevelT): Rect {
  return { x: level.exit.x - PLAYER_WIDTH, y: level.exit.y - PLAYER_HEIGHT, w: PLAYER_WIDTH * 2, h: PLAYER_HEIGHT * 2 };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function isGoal(state: PlayerState, exitRect: Rect): boolean {
  const playerRect: Rect = { x: state.x, y: state.y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT };
  return rectsOverlap(playerRect, exitRect);
}

function reconstructPath(node: SearchNode): InputCmd[] {
  const actions: Action[] = [];
  let current: SearchNode | undefined = node;
  while (current && current.parent && current.action) {
    actions.push(current.action);
    current = current.parent;
  }
  actions.reverse();

  const commands: InputCmd[] = [];
  let prevState = defaultInput();
  actions.forEach((action, index) => {
    const input = action.input;
    const delta: InputCmd = { t: index };
    let changed = false;
    (['left', 'right', 'jump', 'fly', 'thrust'] as const).forEach((key) => {
      if (prevState[key] !== input[key] || index === 0) {
        delta[key] = input[key];
        if (prevState[key] !== input[key]) {
          changed = true;
        }
      }
    });
    if (index === 0 || changed) {
      commands.push(delta);
    }
    prevState = input;
  });
  return commands;
}

export interface SearchOutcome {
  ok: boolean;
  path?: InputCmd[];
  reason?: string;
  nodes: number;
  ms: number;
}

export function findPath(
  level: LevelT,
  timeLimitMs = 3000,
  nodeLimit = 80000,
): SearchOutcome {
  const start = initialPlayerState(level);
  if (!start) {
    return { ok: false, reason: 'no_spawn', nodes: 0, ms: 0 };
  }

  const abilityMask = computeAbilityMask(level);
  const startKey = stateKey(start, abilityMask);
  const exitRect = buildExitRect(level);
  const worldHeight = computeWorldHeight(level);
  const context = createStepContext(level);
  const actions = buildActions(level);
  const gaps = buildGapMap(level);
  const allowFlight = Boolean(level.rules.abilities.shortFly || level.rules.abilities.jetpack);
  const maxGap = maxJumpGapPX(Boolean(level.rules.abilities.highJump)) + 16;

  const queue = new PriorityQueue<SearchNode>();
  const best = new Map<string, number>();
  const startNode: SearchNode = {
    state: start,
    g: 0,
    h: heuristic(start, level.exit.x),
    f: heuristic(start, level.exit.x),
    key: startKey,
    direction: 0,
    stalled: 0,
  };

  queue.push(startNode);
  best.set(startKey, 0);

  const started = Date.now();
  let expanded = 0;

  while (queue.length > 0) {
    if (Date.now() - started > timeLimitMs) {
      return { ok: false, reason: 'timeout', nodes: expanded, ms: Date.now() - started };
    }

    const current = queue.pop()!;
    const bestKnown = best.get(current.key);
    if (bestKnown !== undefined && bestKnown < current.g) {
      continue;
    }

    if (isGoal(current.state, exitRect)) {
      const path = reconstructPath(current);
      return { ok: true, path, nodes: expanded, ms: Date.now() - started };
    }

    expanded += 1;
    if (expanded >= nodeLimit) {
      return { ok: false, reason: 'node_limit', nodes: expanded, ms: Date.now() - started };
    }

    for (const action of actions) {
      const { next, hazard } = advance(level, context, current.state, action.input);
      if (hazard) {
        continue;
      }

      if (next.y > worldHeight + 200) {
        continue;
      }

      if (next.furthestX < current.state.furthestX - 200) {
        continue;
      }

      if (violatesGap(next, gaps, maxGap, allowFlight)) {
        continue;
      }

      const dir = directionFor(action.input);
      const progress = Math.abs(next.x - current.state.x);
      if (dir !== 0 && current.direction !== 0 && dir !== current.direction && progress < 12) {
        continue;
      }

      let stalled = current.stalled;
      if (progress < 4 && dir !== 0) {
        stalled += 1;
        if (stalled >= 3) {
          continue;
        }
      } else if (progress < 2 && dir === 0) {
        stalled = Math.min(3, stalled + 1);
      } else {
        stalled = 0;
      }

      const nextKey = stateKey(next, abilityMask);
      const tentativeG = current.g + 1;
      const known = best.get(nextKey);
      if (known !== undefined && known <= tentativeG) {
        continue;
      }

      const h = heuristic(next, level.exit.x);
      const child: SearchNode = {
        state: next,
        g: tentativeG,
        h,
        f: tentativeG + h,
        parent: current,
        action,
        key: nextKey,
        direction: dir,
        stalled,
      };
      queue.push(child);
      best.set(nextKey, tentativeG);
    }
  }

  return { ok: false, reason: 'no_path', nodes: expanded, ms: Date.now() - started };
}
