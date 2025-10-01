import { Level, LevelT } from '@ir/game-spec';

import { GenerationConstraints } from './generator';

const WALKABLE_TILE_TYPES: LevelT['tiles'][number]['type'][] = ['ground', 'platform', 'moving'];

export interface TestResult {
  success: boolean;
  reason?: string;
}

export function runHeuristicChecks(level: LevelT, constraints: GenerationConstraints): TestResult {
  const validated = Level.parse(level);
  const walkableTiles = validated.tiles
    .filter((tile) => WALKABLE_TILE_TYPES.includes(tile.type))
    .sort((a, b) => a.x - b.x);

  if (walkableTiles.length === 0) {
    return { success: false, reason: 'no_walkable_tiles' };
  }

  for (const tile of walkableTiles) {
    if (tile.w < constraints.minPlatformWidthPX) {
      return { success: false, reason: 'platform_too_narrow' };
    }
  }

  for (let i = 0; i < walkableTiles.length - 1; i += 1) {
    const current = walkableTiles[i];
    const next = walkableTiles[i + 1];
    const gap = next.x - (current.x + current.w);
    if (gap > constraints.maxGapPX) {
      return { success: false, reason: 'gap_too_wide' };
    }

    const step = Math.abs(next.y - current.y);
    if (step > constraints.maxStepUpPX) {
      return { success: false, reason: 'step_too_high' };
    }
  }

  if (validated.exit.x <= walkableTiles[0].x + walkableTiles[0].w) {
    return { success: false, reason: 'exit_not_reachable' };
  }

  const hazards = validated.tiles.filter((tile) => tile.type === 'hazard');
  for (const hazard of hazards) {
    const overlap = walkableTiles.some((tile) => {
      const horizontalOverlap = tile.x < hazard.x + hazard.w && hazard.x < tile.x + tile.w;
      const heightClearance = hazard.y >= tile.y - tile.h && hazard.y <= tile.y + tile.h + 8;
      return horizontalOverlap && heightClearance;
    });
    if (!overlap) {
      return { success: false, reason: 'hazard_without_platform' };
    }
  }

  return { success: true };
}
