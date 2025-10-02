import { Level, LevelT } from '@ir/game-spec';

import { Fail, GapDetail, HazardDetail } from './tester';

const MAX_ADJUST_PX = 48;
const PLATFORM_WIDTH = 48;
const HAZARD_SHIFT_Y = 8;
const ENEMY_SPEED_SCALE = 0.8;
const ENEMY_SHIFT_X = 24;

interface TuneResult {
  patched: LevelT;
  patch: { op: string; info: unknown };
}

function cloneLevel(level: LevelT): LevelT {
  return JSON.parse(JSON.stringify(level)) as LevelT;
}

function finalizeLevel(level: LevelT, patch: { op: string; info: unknown }): TuneResult | null {
  try {
    const validated = Level.parse(level);
    return { patched: validated, patch };
  } catch {
    return null;
  }
}

function extractGap(details: unknown): GapDetail | null {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const record = details as Record<string, unknown>;
  if ('gap' in record && record.gap && typeof record.gap === 'object') {
    const gap = record.gap as Record<string, unknown>;
    if (
      typeof gap.fromX === 'number' &&
      typeof gap.toX === 'number' &&
      typeof gap.gap === 'number' &&
      typeof gap.y === 'number'
    ) {
      return {
        prevIndex: typeof gap.prevIndex === 'number' ? (gap.prevIndex as number) : null,
        nextIndex: typeof gap.nextIndex === 'number' ? (gap.nextIndex as number) : null,
        fromX: gap.fromX,
        toX: gap.toX,
        gap: gap.gap,
        maxGapPx: typeof gap.maxGapPx === 'number' ? (gap.maxGapPx as number) : undefined,
        y: gap.y,
      };
    }
  }
  return null;
}

function extractHazard(details: unknown): HazardDetail | null {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const record = details as Record<string, unknown>;
  if ('hazard' in record && record.hazard && typeof record.hazard === 'object') {
    const hazard = record.hazard as Record<string, unknown>;
    if (typeof hazard.tileIndex === 'number' && hazard.tile && typeof hazard.tile === 'object') {
      const tile = hazard.tile as Record<string, unknown>;
      if (
        typeof tile.x === 'number' &&
        typeof tile.y === 'number' &&
        typeof tile.w === 'number' &&
        typeof tile.h === 'number' &&
        typeof tile.type === 'string'
      ) {
        return {
          tileIndex: hazard.tileIndex as number,
          tile: {
            x: tile.x,
            y: tile.y,
            w: tile.w,
            h: tile.h,
            type: tile.type as LevelT['tiles'][number]['type'],
          },
        };
      }
    }
  }
  return null;
}

function adjustGap(level: LevelT, fail: Fail): TuneResult | null {
  const gapDetail = extractGap(fail.details);
  const patched = cloneLevel(level);

  if (gapDetail) {
    const prevIndex = gapDetail.prevIndex ?? null;
    const nextIndex = gapDetail.nextIndex ?? null;
    const previousTile = prevIndex !== null ? { ...patched.tiles[prevIndex] } : null;
    const targetGap = Math.max((gapDetail.maxGapPx ?? gapDetail.gap) - 16, 0);
    const reduce = Math.min(Math.max(gapDetail.gap - targetGap, 0), MAX_ADJUST_PX, gapDetail.gap);

    if (previousTile && reduce > 0) {
      previousTile.w += reduce;
      patched.tiles[prevIndex!] = previousTile;
      return finalizeLevel(patched, {
        op: 'extend_tile',
        info: { tileIndex: prevIndex, deltaW: reduce },
      });
    }

    const neighborIndex = prevIndex ?? nextIndex;
    const neighbor = neighborIndex !== null ? patched.tiles[neighborIndex] : undefined;
    const height = neighbor ? neighbor.h : 16;
    const gapCenter = gapDetail.fromX + gapDetail.gap / 2;
    const platformX = Math.round(gapCenter - PLATFORM_WIDTH / 2);
    const newTile: LevelT['tiles'][number] = {
      x: platformX,
      y: gapDetail.y,
      w: PLATFORM_WIDTH,
      h: height,
      type: 'platform',
    };
    patched.tiles.push(newTile);
    return finalizeLevel(patched, {
      op: 'add_platform',
      info: { tile: newTile, gap: gapDetail },
    });
  }

  if (fail.at) {
    const newTile: LevelT['tiles'][number] = {
      x: Math.round(fail.at.x - PLATFORM_WIDTH / 2),
      y: fail.at.y,
      w: PLATFORM_WIDTH,
      h: 16,
      type: 'platform',
    };
    patched.tiles.push(newTile);
    return finalizeLevel(patched, {
      op: 'add_platform',
      info: { tile: newTile },
    });
  }

  return null;
}

function adjustHazard(level: LevelT, fail: Fail): TuneResult | null {
  const patched = cloneLevel(level);
  const hazard = extractHazard(fail.details);

  if (hazard && patched.tiles[hazard.tileIndex]?.type === 'hazard') {
    const tile = { ...patched.tiles[hazard.tileIndex] };
    tile.y += Math.min(HAZARD_SHIFT_Y, MAX_ADJUST_PX);
    patched.tiles[hazard.tileIndex] = tile;
    return finalizeLevel(patched, {
      op: 'shift_hazard',
      info: { tileIndex: hazard.tileIndex, deltaY: Math.min(HAZARD_SHIFT_Y, MAX_ADJUST_PX) },
    });
  }

  if (fail.at) {
    const movingIndex = patched.moving?.findIndex((platform) => {
      const [fx, fy] = platform.from;
      const [tx, ty] = platform.to;
      const dx1 = fail.at!.x - fx;
      const dy1 = fail.at!.y - fy;
      const dx2 = fail.at!.x - tx;
      const dy2 = fail.at!.y - ty;
      const dist = Math.min(Math.hypot(dx1, dy1), Math.hypot(dx2, dy2));
      return dist <= 64;
    });
    if (movingIndex !== undefined && movingIndex >= 0) {
      const moving = { ...patched.moving[movingIndex] };
      moving.period_ms += 200;
      patched.moving[movingIndex] = moving;
      return finalizeLevel(patched, {
        op: 'extend_period',
        info: { movingIndex, period_ms: moving.period_ms },
      });
    }
  }

  return null;
}

function adjustEnemy(level: LevelT, fail: Fail): TuneResult | null {
  const patched = cloneLevel(level);
  const details = (fail.details ?? {}) as Record<string, unknown>;
  let enemyIndex: number | null = null;
  if (typeof details.enemyIndex === 'number') {
    enemyIndex = details.enemyIndex;
  } else if (fail.at) {
    const candidate = patched.enemies.findIndex(
      (enemy) => Math.hypot(enemy.x - fail.at!.x, enemy.y - fail.at!.y) <= 96,
    );
    if (candidate >= 0) {
      enemyIndex = candidate;
    }
  }

  if (enemyIndex === null || enemyIndex < 0 || enemyIndex >= patched.enemies.length) {
    return null;
  }

  const enemy = { ...patched.enemies[enemyIndex] };
  const scaled = enemy.speed * ENEMY_SPEED_SCALE;
  if (scaled >= enemy.speed * 0.99) {
    enemy.x -= ENEMY_SHIFT_X;
    patched.enemies[enemyIndex] = enemy;
    return finalizeLevel(patched, {
      op: 'shift_enemy_spawn',
      info: { enemyIndex, deltaX: -ENEMY_SHIFT_X },
    });
  }

  enemy.speed = Math.max(10, scaled);
  patched.enemies[enemyIndex] = enemy;
  return finalizeLevel(patched, {
    op: 'slow_enemy',
    info: { enemyIndex, speed: enemy.speed },
  });
}

function ensureClosestGap(fail: Fail): GapDetail | null {
  const gap = extractGap(fail.details);
  if (gap) {
    return gap;
  }
  if (fail.details && typeof fail.details === 'object') {
    const record = fail.details as Record<string, unknown>;
    if (record.closestGap && typeof record.closestGap === 'object') {
      return extractGap({ gap: record.closestGap });
    }
  }
  return null;
}

function addHelperPlatform(level: LevelT, fail: Fail): TuneResult | null {
  const patched = cloneLevel(level);
  const gap = ensureClosestGap(fail);
  const y = gap?.y ?? fail.at?.y ?? level.exit.y;
  const x = gap
    ? gap.fromX + Math.max((gap.gap - PLATFORM_WIDTH) / 2, -PLATFORM_WIDTH / 2)
    : (fail.at?.x ?? level.exit.x - PLATFORM_WIDTH);
  const tile: LevelT['tiles'][number] = {
    x: Math.round(x),
    y,
    w: PLATFORM_WIDTH,
    h: 16,
    type: 'platform',
  };
  patched.tiles.push(tile);
  return finalizeLevel(patched, {
    op: 'add_helper_platform',
    info: { tile, gap },
  });
}

function addSpawnPlatform(level: LevelT, fail: Fail): TuneResult | null {
  const patched = cloneLevel(level);
  const groundY = fail.at?.y ?? level.exit.y;
  const tile: LevelT['tiles'][number] = {
    x: 0,
    y: groundY,
    w: 96,
    h: 16,
    type: 'ground',
  };
  patched.tiles.push(tile);
  return finalizeLevel(patched, {
    op: 'add_spawn_platform',
    info: { tile },
  });
}

export function tune(level: LevelT, fail: Fail): TuneResult | null {
  switch (fail.reason) {
    case 'gap_too_wide':
      return adjustGap(level, fail);
    case 'hazard_no_window':
      return adjustHazard(level, fail);
    case 'enemy_unavoidable':
      return adjustEnemy(level, fail);
    case 'no_spawn':
      return addSpawnPlatform(level, fail);
    case 'no_path':
    case 'timeout':
      return addHelperPlatform(level, fail);
    default:
      return null;
  }
}
