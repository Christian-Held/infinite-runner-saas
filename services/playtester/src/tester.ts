import { LevelT } from '@ir/game-spec';

import { maxJumpGapPX, InputCmd, InputState, simulate } from './sim/arcade';
import { searchLevel } from './sim/search';

const WALKABLE_TILE_TYPES: LevelT['tiles'][number]['type'][] = ['ground', 'platform'];

interface PrecheckResult {
  ok: boolean;
  reason?: string;
}

function runPrechecks(level: LevelT): PrecheckResult {
  const tiles = level.tiles.filter((tile) => WALKABLE_TILE_TYPES.includes(tile.type));
  if (tiles.length === 0) {
    return { ok: false, reason: 'no_spawn' };
  }

  tiles.sort((a, b) => a.x - b.x);

  const maxGap = maxJumpGapPX(Boolean(level.rules.abilities.highJump)) + 16;
  for (let i = 0; i < tiles.length - 1; i += 1) {
    const current = tiles[i];
    const next = tiles[i + 1];
    const gap = next.x - (current.x + current.w);
    if (gap > maxGap) {
      return { ok: false, reason: 'gap_too_wide' };
    }
  }

  const hazards = level.tiles.filter((tile) => tile.type === 'hazard');
  for (const hazard of hazards) {
    const hasWindow = tiles.some((tile) => {
      const horizontal = tile.x < hazard.x + hazard.w && hazard.x < tile.x + tile.w;
      const vertical = hazard.y >= tile.y - tile.h && hazard.y <= tile.y + 8;
      return horizontal && vertical;
    });
    if (!hasWindow) {
      return { ok: false, reason: 'hazard_no_window' };
    }
  }

  return { ok: true };
}

function compressPath(states: InputState[]): InputCmd[] {
  const result: InputCmd[] = [];
  let prev: InputState = { left: false, right: false, jump: false, fly: false, thrust: false };

  states.forEach((state, index) => {
    const changes: Partial<InputState> = {};
    if (state.left !== prev.left) {
      changes.left = state.left;
    }
    if (state.right !== prev.right) {
      changes.right = state.right;
    }
    if (state.jump !== prev.jump) {
      changes.jump = state.jump;
    }
    if (state.fly !== prev.fly) {
      changes.fly = state.fly;
    }
    if (state.thrust !== prev.thrust) {
      changes.thrust = state.thrust;
    }

    if (Object.keys(changes).length > 0 || index === 0) {
      result.push({
        t: index,
        left: index === 0 ? state.left : changes.left,
        right: index === 0 ? state.right : changes.right,
        jump: index === 0 ? state.jump : changes.jump,
        fly: index === 0 ? state.fly : changes.fly,
        thrust: index === 0 ? state.thrust : changes.thrust,
      });
      prev = { ...state };
    }
  });

  return result;
}

export interface TestLevelResult {
  ok: boolean;
  path?: InputCmd[];
  reason?: string;
  nodes?: number;
  visited?: number;
  durationMs?: number;
}

export async function testLevel(level: LevelT): Promise<TestLevelResult> {
  const precheck = runPrechecks(level);
  if (!precheck.ok) {
    return { ok: false, reason: precheck.reason };
  }

  const startedAt = Date.now();
  const search = searchLevel(level, { timeLimitMs: 3000, maxNodes: 80000 });
  const durationMs = Date.now() - startedAt;
  if (!search.ok || !search.path) {
    return {
      ok: false,
      reason: search.reason ?? 'no_path',
      nodes: search.nodesExpanded,
      visited: search.visitedStates,
      durationMs,
    };
  }

  const path = compressPath(search.path);
  const simulation = simulate(level, path);
  if (!simulation.ok) {
    return {
      ok: false,
      reason: simulation.reason ?? 'no_path',
      nodes: search.nodesExpanded,
      visited: search.visitedStates,
      durationMs,
    };
  }

  return {
    ok: true,
    path,
    nodes: search.nodesExpanded,
    visited: search.visitedStates,
    durationMs,
  };
}
