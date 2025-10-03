import { LevelT, getLevelPlan } from '@ir/game-spec';

import type { Logger } from '@ir/logger';

import { InputCmd, InputState, createSpawn, maxJumpGapPX, simulate } from './sim/arcade';
import { findPath } from './sim/search';

const WALKABLE_TILE_TYPES: LevelT['tiles'][number]['type'][] = ['ground', 'platform'];
const SAFETY_GAP_PX = 16;
const MIN_PLATFORM_WIDTH = 48;
const HAZARD_PERIOD_RANGE: [number, number] = [800, 2200];

type HazardTile = Extract<LevelT['tiles'][number], { type: 'hazard' }>;

function minHazardOpeningMs(levelNumber: number): number {
  const t = Math.min(Math.max((levelNumber - 1) / 99, 0), 1);
  const interpolated = 320 - (320 - 180) * t;
  return Math.max(160, Math.round(interpolated));
}

function movingCenter(moving: LevelT['moving'][number]): { x: number; y: number } {
  const [fromX, fromY] = moving.from;
  const [toX, toY] = moving.to;
  return { x: (fromX + toX) / 2, y: (fromY + toY) / 2 };
}

export type FailReason =
  | 'gap_too_wide'
  | 'hazard_no_window'
  | 'hazard_window_small'
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
  tile: HazardTile;
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

  const plan = getLevelPlan(level.rules.difficulty ?? 1);
  const minOpening = minHazardOpeningMs(plan.levelNumber);
  const [minPeriod, maxPeriod] = HAZARD_PERIOD_RANGE;

  for (const [index, moving] of (level.moving ?? []).entries()) {
    if (typeof moving.open_ms !== 'number') {
      continue;
    }
    if (
      moving.open_ms < minOpening ||
      moving.period_ms < minPeriod ||
      moving.period_ms > maxPeriod
    ) {
      const center = movingCenter(moving);
      return {
        ok: false,
        fail: {
          ok: false,
          reason: 'hazard_window_small',
          at: center,
          details: {
            movingIndex: index,
            moving: {
              id: moving.id,
              from: [...moving.from],
              to: [...moving.to],
              period_ms: moving.period_ms,
              open_ms: moving.open_ms,
            },
            minOpeningMs: minOpening,
            periodRange: [minPeriod, maxPeriod],
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

export function findHazardNear(
  level: LevelT,
  rect?: { x: number; y: number; w: number; h: number },
): HazardDetail | null {
  if (!rect) {
    return null;
  }

  const hazardEntries = level.tiles
    .map((tile, index) => ({ tile, index }))
    .filter((entry): entry is { tile: HazardTile; index: number } => entry.tile.type === 'hazard');

  if (hazardEntries.length === 0) {
    return null;
  }

  const centerX = rect.x + rect.w / 2;
  const centerY = rect.y + rect.h / 2;

  const overlaps = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  let bestOverlap: { tileIndex: number; tile: HazardTile; distance: number } | null = null;
  let bestNearby: { tileIndex: number; tile: HazardTile; distance: number } | null = null;

  for (const entry of hazardEntries) {
    const tileRect = { x: entry.tile.x, y: entry.tile.y, w: entry.tile.w, h: entry.tile.h };
    const tileCenterX = tileRect.x + tileRect.w / 2;
    const tileCenterY = tileRect.y + tileRect.h / 2;
    const dx = tileCenterX - centerX;
    const dy = tileCenterY - centerY;
    const distance = dx * dx + dy * dy;

    if (overlaps(rect, tileRect)) {
      if (!bestOverlap || distance < bestOverlap.distance) {
        const tileCopy: HazardTile = { ...entry.tile };
        bestOverlap = { tileIndex: entry.index, tile: tileCopy, distance };
      }
      continue;
    }

    if (Math.abs(dx) <= 24 && Math.abs(dy) <= 24) {
      if (!bestNearby || distance < bestNearby.distance) {
        const tileCopy: HazardTile = { ...entry.tile };
        bestNearby = { tileIndex: entry.index, tile: tileCopy, distance };
      }
    }
  }

  if (bestOverlap) {
    return { tileIndex: bestOverlap.tileIndex, tile: bestOverlap.tile };
  }

  if (bestNearby) {
    return { tileIndex: bestNearby.tileIndex, tile: bestNearby.tile };
  }

  return null;
}

export async function testLevel(level: LevelT, logger: Logger): Promise<TestLevelResult> {
  const precheck = runPrechecks(level);
  if (!precheck.ok) {
    logger.warn({ reason: precheck.fail.reason, at: precheck.fail.at }, 'Precheck failed');
    return { ok: false, fail: precheck.fail, reason: precheck.fail.reason };
  }

  const search = findPath(level, 3000, 80000);
  if (!search.ok || !search.path) {
    const fail = mapSearchFail(level, search.reason);
    logger.warn({ reason: fail.reason, nodes: search.nodes, durationMs: search.ms }, 'Pathfinding failed');
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
      const hazardRect =
        simulation.fail?.hazard ??
        (failPoint
          ? { x: failPoint.x - 16, y: failPoint.y - 16, w: 32, h: 32 }
          : undefined);
      const hazard = findHazardNear(level, hazardRect);
      const details: Record<string, unknown> = {};
      if (hazard) {
        details.hazard = hazard;
      } else if (hazardRect) {
        details.rect = hazardRect;
      }
      const fail: Fail = {
        ok: false,
        reason: 'hazard_no_window',
        at: failPoint,
        details: Object.keys(details).length > 0 ? details : undefined,
      };
      logger.warn(
        { reason: fail.reason, at: failPoint, nodes: search.nodes, durationMs: search.ms },
        'Simulation hazard failure',
      );
      return {
        ok: false,
        fail,
        reason: fail.reason,
        nodes: search.nodes,
        durationMs: search.ms,
      };
    }

    const fail = mapSearchFail(level, simulation.reason === 'timeout' ? 'timeout' : 'no_path');
    logger.warn(
      { reason: fail.reason, nodes: search.nodes, durationMs: search.ms },
      'Simulation failure',
    );
    return {
      ok: false,
      fail,
      reason: fail.reason,
      nodes: search.nodes,
      durationMs: search.ms,
    };
  }

  logger.info({ nodes: search.nodes, durationMs: search.ms }, 'Test level succeeded');
  return {
    ok: true,
    path: simulation.path.length > 0 ? simulation.path : path,
    nodes: search.nodes,
    durationMs: search.ms,
  };
}
