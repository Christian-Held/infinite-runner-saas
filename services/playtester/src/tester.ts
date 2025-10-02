import { LevelT } from '@ir/game-spec';

import { InputCmd, InputState, createSpawn, maxJumpGapPX, simulate } from './sim/arcade';
import { findPath } from './sim/search';

const WALKABLE_TILE_TYPES: LevelT['tiles'][number]['type'][] = ['ground', 'platform'];
const SAFETY_GAP_PX = 16;
const MIN_PLATFORM_WIDTH = 48;

export type FailReason =
  | 'gap_too_wide'
  | 'hazard_no_window'
  | 'enemy_unavoidable'
  | 'no_spawn'
  | 'no_path'
  | 'timeout';

export interface GapDetail {
  prevIndex: number | null;
  nextIndex: number | null;
  fromX: number;
  toX: number;
  gap: number;
  maxGapPx?: number;
  y: number;
}

export interface HazardDetail {
  tileIndex: number;
  tile: LevelT['tiles'][number];
}

export interface Fail {
  ok: false;
  reason: FailReason;
  at?: { x: number; y: number };
  details?: unknown;
}

interface PrecheckResult {
  ok: true;
}

interface PrecheckFailure {
  ok: false;
  fail: Fail;
}

type PrecheckOutcome = PrecheckResult | PrecheckFailure;

function defaultInputState(): InputState {
  return { left: false, right: false, jump: false, fly: false, thrust: false };
}

function applyCommand(state: InputState, command: InputCmd): InputState {
  const next = { ...state };
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

function compressPath(commands: InputCmd[]): InputCmd[] {
  const sorted = [...commands].sort((a, b) => a.t - b.t);
  const result: InputCmd[] = [];
  let previous = defaultInputState();

  for (const command of sorted) {
    const next = applyCommand(previous, command);
    const delta: InputCmd = { t: command.t };
    let changed = false;

    (['left', 'right', 'jump', 'fly', 'thrust'] as const).forEach((key) => {
      if (previous[key] !== next[key] || command.t === 0) {
        delta[key] = next[key];
        if (previous[key] !== next[key]) {
          changed = true;
        }
      }
    });

    if (command.t === 0 || changed) {
      result.push(delta);
    }

    previous = next;
  }

  return result;
}

function mapWalkable(level: LevelT) {
  return level.tiles
    .map((tile, index) => ({ tile, index }))
    .filter((entry) => WALKABLE_TILE_TYPES.includes(entry.tile.type))
    .sort((a, b) => a.tile.x - b.tile.x);
}

function findLargestGap(level: LevelT, maxGapPx: number): GapDetail | null {
  const walkable = mapWalkable(level);
  let widest: GapDetail | null = null;
  for (let i = 0; i < walkable.length - 1; i += 1) {
    const current = walkable[i];
    const next = walkable[i + 1];
    const gap = next.tile.x - (current.tile.x + current.tile.w);
    if (gap <= 0) {
      continue;
    }
    if (!widest || gap > widest.gap) {
      widest = {
        prevIndex: current.index,
        nextIndex: next.index,
        fromX: current.tile.x + current.tile.w,
        toX: next.tile.x,
        gap,
        maxGapPx,
        y: current.tile.y,
      };
    }
  }
  return widest;
}

function runPrechecks(level: LevelT): PrecheckOutcome {
  const spawn = createSpawn(level);
  if (!spawn) {
    return {
      ok: false,
      fail: {
        ok: false,
        reason: 'no_spawn',
        at: { x: 0, y: level.exit.y },
        details: { message: 'no_valid_spawn' },
      },
    };
  }

  if (level.exit.x <= spawn.x) {
    return {
      ok: false,
      fail: {
        ok: false,
        reason: 'no_path',
        at: { x: level.exit.x, y: level.exit.y },
        details: { spawnX: spawn.x },
      },
    };
  }

  const walkable = level.tiles
    .map((tile, index) => ({ tile, index }))
    .filter((entry) => WALKABLE_TILE_TYPES.includes(entry.tile.type));

  for (const entry of walkable) {
    if (entry.tile.w < MIN_PLATFORM_WIDTH) {
      return {
        ok: false,
        fail: {
          ok: false,
          reason: 'gap_too_wide',
          at: { x: entry.tile.x, y: entry.tile.y },
          details: {
            tileIndex: entry.index,
            tile: { ...entry.tile },
            minWidth: MIN_PLATFORM_WIDTH,
          },
        },
      };
    }
  }

  const sorted = [...walkable].sort((a, b) => a.tile.x - b.tile.x);
  const maxGap = maxJumpGapPX(Boolean(level.rules.abilities.highJump)) + SAFETY_GAP_PX;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    const gap = next.tile.x - (current.tile.x + current.tile.w);
    if (gap > maxGap) {
      return {
        ok: false,
        fail: {
          ok: false,
          reason: 'gap_too_wide',
          at: { x: current.tile.x + current.tile.w, y: current.tile.y },
          details: {
            gap: {
              prevIndex: current.index,
              nextIndex: next.index,
              fromX: current.tile.x + current.tile.w,
              toX: next.tile.x,
              gap,
              maxGapPx: maxGap,
              y: current.tile.y,
            } satisfies GapDetail,
          },
        },
      };
    }
  }

  const hazards = level.tiles
    .map((tile, index) => ({ tile, index }))
    .filter((entry) => entry.tile.type === 'hazard');

  for (const hazard of hazards) {
    const hasWindow = walkable.some((entry) => {
      const tile = entry.tile;
      const horizontal = tile.x < hazard.tile.x + hazard.tile.w && hazard.tile.x < tile.x + tile.w;
      const vertical = hazard.tile.y >= tile.y - tile.h && hazard.tile.y <= tile.y + 8;
      return horizontal && vertical;
    });
    if (!hasWindow) {
      return {
        ok: false,
        fail: {
          ok: false,
          reason: 'hazard_no_window',
          at: { x: hazard.tile.x + hazard.tile.w / 2, y: hazard.tile.y },
          details: {
            hazard: {
              tileIndex: hazard.index,
              tile: { ...hazard.tile },
            } satisfies HazardDetail,
          },
        },
      };
    }
  }

  return { ok: true };
}

export interface TestLevelResult {
  ok: boolean;
  path?: InputCmd[];
  fail?: Fail;
  reason?: FailReason;
  nodes?: number;
  durationMs?: number;
}

function mapSearchFail(level: LevelT, reason?: string): Fail {
  const maxGap = maxJumpGapPX(Boolean(level.rules.abilities.highJump)) + SAFETY_GAP_PX;
  const closestGap = findLargestGap(level, maxGap);

  if (!reason) {
    return {
      ok: false,
      reason: 'no_path',
      at: closestGap ? { x: closestGap.fromX, y: closestGap.y } : undefined,
      details: closestGap ? { closestGap } : undefined,
    };
  }

  if (reason === 'timeout' || reason === 'node_limit') {
    return {
      ok: false,
      reason: 'timeout',
      at: closestGap ? { x: closestGap.fromX, y: closestGap.y } : undefined,
      details: closestGap ? { closestGap } : undefined,
    };
  }

  if (reason === 'no_spawn') {
    return {
      ok: false,
      reason: 'no_spawn',
      at: { x: 0, y: level.exit.y },
      details: { message: 'search_no_spawn' },
    };
  }

  return {
    ok: false,
    reason: 'no_path',
    at: closestGap ? { x: closestGap.fromX, y: closestGap.y } : undefined,
    details: closestGap ? { closestGap } : undefined,
  };
}

function findHazardNear(level: LevelT, point?: { x: number; y: number }) {
  if (!point) {
    return null;
  }
  const hazardEntries = level.tiles
    .map((tile, index) => ({ tile, index }))
    .filter((entry) => entry.tile.type === 'hazard');
  for (const entry of hazardEntries) {
    if (
      point.x >= entry.tile.x &&
      point.x <= entry.tile.x + entry.tile.w &&
      point.y >= entry.tile.y &&
      point.y <= entry.tile.y + entry.tile.h
    ) {
      return {
        tileIndex: entry.index,
        tile: { ...entry.tile },
      } satisfies HazardDetail;
    }
  }
  return null;
}

export async function testLevel(level: LevelT): Promise<TestLevelResult> {
  const precheck = runPrechecks(level);
  if (!precheck.ok) {
    return { ok: false, fail: precheck.fail, reason: precheck.fail.reason };
  }

  const search = findPath(level, 3000, 80000);
  if (!search.ok || !search.path) {
    const fail = mapSearchFail(level, search.reason);
    return {
      ok: false,
      fail,
      reason: fail.reason,
      nodes: search.nodes,
      durationMs: search.ms,
    };
  }

  const path = compressPath(search.path);
  const simulation = simulate(level, path);
  if (!simulation.ok) {
    if (simulation.reason === 'hazard') {
      const failPoint = simulation.fail?.at;
      const hazard = simulation.fail?.hazard ?? findHazardNear(level, failPoint ?? undefined);
      const fail: Fail = {
        ok: false,
        reason: 'hazard_no_window',
        at: failPoint,
        details: hazard ? { hazard } : undefined,
      };
      return {
        ok: false,
        fail,
        reason: fail.reason,
        nodes: search.nodes,
        durationMs: search.ms,
      };
    }

    const fail = mapSearchFail(level, simulation.reason === 'timeout' ? 'timeout' : 'no_path');
    return {
      ok: false,
      fail,
      reason: fail.reason,
      nodes: search.nodes,
      durationMs: search.ms,
    };
  }

  return {
    ok: true,
    path: simulation.path.length > 0 ? simulation.path : path,
    nodes: search.nodes,
    durationMs: search.ms,
  };
}
