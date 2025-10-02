import { LevelT } from '@ir/game-spec';

import {
  MOVE_SPEED,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  InputState,
  PlayerState,
  initialPlayerState,
  maxJumpGapPX,
  step,
} from './arcade';

interface Action {
  name: string;
  input: InputState;
}

interface SearchNode {
  state: PlayerState;
  g: number;
  h: number;
  f: number;
  key: string;
  parent?: SearchNode;
  action?: Action;
  stepIndex: number;
  direction: number;
}

export interface SearchOptions {
  timeLimitMs: number;
  maxNodes: number;
}

export interface SearchOutcome {
  ok: boolean;
  reason?: string;
  path?: InputState[];
  nodesExpanded: number;
  visitedStates: number;
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

function makeExitRect(level: LevelT): Rect {
  return { x: level.exit.x - 16, y: level.exit.y - 48, w: 32, h: 48 };
}

function toInputState(action: Partial<InputState>): InputState {
  return {
    left: Boolean(action.left),
    right: Boolean(action.right),
    jump: Boolean(action.jump),
    fly: Boolean(action.fly),
    thrust: Boolean(action.thrust),
  };
}

function buildActions(level: LevelT): Action[] {
  const base: Action[] = [
    { name: 'idle', input: toInputState({}) },
    { name: 'left', input: toInputState({ left: true }) },
    { name: 'right', input: toInputState({ right: true }) },
    { name: 'jump', input: toInputState({ jump: true }) },
    { name: 'left_jump', input: toInputState({ left: true, jump: true }) },
    { name: 'right_jump', input: toInputState({ right: true, jump: true }) },
  ];

  if (level.rules.abilities.shortFly) {
    base.push({ name: 'fly', input: toInputState({ fly: true }) });
    base.push({ name: 'fly_right', input: toInputState({ right: true, fly: true }) });
    base.push({ name: 'fly_left', input: toInputState({ left: true, fly: true }) });
  }

  if (level.rules.abilities.jetpack) {
    base.push({ name: 'thrust', input: toInputState({ thrust: true }) });
    base.push({ name: 'thrust_right', input: toInputState({ right: true, thrust: true }) });
    base.push({ name: 'thrust_left', input: toInputState({ left: true, thrust: true }) });
  }

  return base;
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

function quantise(value: number, stepSize: number): number {
  return Math.round(value / stepSize) * stepSize;
}

function stateKey(state: PlayerState): string {
  const x = quantise(state.x, 2);
  const y = quantise(state.y, 2);
  const vx = quantise(state.vx, 2);
  const vy = quantise(state.vy, 2);
  const framePhase = state.frame % 120;
  const ground = state.onGround ? 1 : 0;
  const fly = state.shortFlyAvailable ? 1 : 0;
  const fuel = Math.round(state.jetpackFuel);
  return `${framePhase}|${x}|${y}|${vx}|${vy}|${ground}|${fly}|${fuel}`;
}

function heuristic(state: PlayerState, exitRect: Rect): number {
  const dx = Math.max(0, exitRect.x - state.x);
  const seconds = dx / MOVE_SPEED;
  return seconds * 30;
}

function advance(level: LevelT, state: PlayerState, action: Action): { next: PlayerState; hazard: boolean } {
  let current = state;
  let hazard = false;
  for (let i = 0; i < 2; i += 1) {
    const result = step(level, current, action.input);
    hazard = hazard || result.collidedHazard;
    current = result;
  }
  return { next: current, hazard };
}

function reconstructPath(node: SearchNode): InputState[] {
  const states: InputState[] = [];
  let current: SearchNode | undefined = node;
  while (current && current.parent && current.action) {
    const input = current.action.input;
    states.push({ ...input });
    current = current.parent;
  }
  states.reverse();
  return states;
}

function computeWorldHeight(level: LevelT): number {
  const tileMax = level.tiles.reduce((max, tile) => Math.max(max, tile.y + tile.h), 0);
  return Math.max(tileMax, level.exit.y);
}

function buildGapMap(level: LevelT): Array<{ fromX: number; toX: number; gap: number; y: number }> {
  const walkable = level.tiles
    .filter((tile) => tile.type === 'ground' || tile.type === 'platform')
    .sort((a, b) => a.x - b.x);

  const gaps: Array<{ fromX: number; toX: number; gap: number; y: number }> = [];
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

function violatesGapPrune(state: PlayerState, action: Action, gaps: Array<{ fromX: number; toX: number; gap: number; y: number }>, maxGap: number): boolean {
  if (action.input.right === false || action.input.left) {
    return false;
  }
  const playerBottom = state.y + PLAYER_HEIGHT;
  for (const gap of gaps) {
    if (state.x <= gap.fromX && playerBottom <= gap.y + 2 && playerBottom >= gap.y - PLAYER_HEIGHT) {
      if (gap.gap > maxGap) {
        return true;
      }
    }
  }
  return false;
}

class PriorityQueue {
  private heap: SearchNode[] = [];

  push(node: SearchNode) {
    this.heap.push(node);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): SearchNode | undefined {
    if (this.heap.length === 0) {
      return undefined;
    }
    const first = this.heap[0];
    const last = this.heap.pop();
    if (!last) {
      return first;
    }
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  get length(): number {
    return this.heap.length;
  }

  private bubbleUp(index: number) {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.heap[current].f >= this.heap[parent].f) {
        break;
      }
      [this.heap[current], this.heap[parent]] = [this.heap[parent], this.heap[current]];
      current = parent;
    }
  }

  private bubbleDown(index: number) {
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

export function searchLevel(level: LevelT, options: SearchOptions): SearchOutcome {
  const startState = initialPlayerState(level);
  if (!startState) {
    return { ok: false, reason: 'no_spawn', nodesExpanded: 0, visitedStates: 0 };
  }

  const exitRect = makeExitRect(level);
  const maxGap = maxJumpGapPX(Boolean(level.rules.abilities.highJump)) + 24;
  const worldHeight = computeWorldHeight(level);
  const gaps = buildGapMap(level);

  const startNode: SearchNode = {
    state: startState,
    g: 0,
    h: heuristic(startState, exitRect),
    f: heuristic(startState, exitRect),
    key: stateKey(startState),
    parent: undefined,
    action: undefined,
    stepIndex: 0,
    direction: 0,
  };

  const open = new PriorityQueue();
  open.push(startNode);

  const visited = new Map<string, number>();
  visited.set(startNode.key, 0);

  const actions = buildActions(level);

  const startTime = Date.now();
  let nodesExpanded = 0;
  let visitedStates = 0;
  let bestX = startState.x;

  while (open.length > 0) {
    if (Date.now() - startTime > options.timeLimitMs) {
      return { ok: false, reason: 'timeout', nodesExpanded, visitedStates };
    }
    if (nodesExpanded >= options.maxNodes) {
      return { ok: false, reason: 'timeout', nodesExpanded, visitedStates };
    }

    const current = open.pop();
    if (!current) {
      break;
    }
    nodesExpanded += 1;
    visitedStates = visited.size;

    const playerRect: Rect = { x: current.state.x, y: current.state.y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT };
    if (rectsOverlap(playerRect, exitRect)) {
      const states = reconstructPath(current);
      return { ok: true, path: states, nodesExpanded, visitedStates };
    }

    if (current.state.x > bestX) {
      bestX = current.state.x;
    }

    for (const action of actions) {
      if (violatesGapPrune(current.state, action, gaps, maxGap)) {
        continue;
      }

      const { next, hazard } = advance(level, current.state, action);
      if (hazard) {
        continue;
      }

      if (next.y > worldHeight + 200) {
        continue;
      }

      if (next.x < bestX - 200) {
        continue;
      }

      const newDir = directionFor(action.input);
      if (current.parent && current.action) {
        const prevDir = current.direction;
        const parentDir = current.parent.direction;
        if (prevDir !== 0 && newDir !== 0 && Math.sign(prevDir) !== Math.sign(newDir)) {
          const ancestor = current.parent.state;
          if (Math.abs(next.x - ancestor.x) < 4) {
            continue;
          }
        }
        if (parentDir !== 0 && newDir !== 0 && Math.sign(parentDir) !== Math.sign(newDir)) {
          const grand = current.parent.parent?.state ?? current.parent.state;
          if (Math.abs(next.x - grand.x) < 4) {
            continue;
          }
        }
      }

      const key = stateKey(next);
      const g = current.g + 1;
      const previousCost = visited.get(key);
      if (previousCost !== undefined && previousCost <= g) {
        continue;
      }
      visited.set(key, g);

      const h = heuristic(next, exitRect);
      const node: SearchNode = {
        state: next,
        g,
        h,
        f: g + h,
        key,
        parent: current,
        action,
        stepIndex: current.stepIndex + 1,
        direction: newDir === 0 ? current.direction : newDir,
      };
      open.push(node);
    }
  }

  return { ok: false, reason: 'no_path', nodesExpanded, visitedStates };
}
