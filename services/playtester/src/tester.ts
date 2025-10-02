import { LevelT } from '@ir/game-spec';

import { InputCmd, InputState, createSpawn, maxJumpGapPX, simulate } from './sim/arcade';
import { findPath } from './sim/search';

const WALKABLE_TILE_TYPES: LevelT['tiles'][number]['type'][] = ['ground', 'platform'];
const SAFETY_GAP_PX = 16;
const MIN_PLATFORM_WIDTH = 48;

interface PrecheckResult {
  ok: boolean;
  reason?: string;
}

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

function runPrechecks(level: LevelT): PrecheckResult {
  const spawn = createSpawn(level);
  if (!spawn) {
    return { ok: false, reason: 'no_spawn' };
  }

  if (level.exit.x <= spawn.x) {
    return { ok: false, reason: 'no_path' };
  }

  const walkable = level.tiles.filter((tile) => WALKABLE_TILE_TYPES.includes(tile.type));
  if (walkable.some((tile) => tile.w < MIN_PLATFORM_WIDTH)) {
    return { ok: false, reason: 'gap_too_wide' };
  }

  const sorted = [...walkable].sort((a, b) => a.x - b.x);
  const maxGap = maxJumpGapPX(Boolean(level.rules.abilities.highJump)) + SAFETY_GAP_PX;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    const gap = next.x - (current.x + current.w);
    if (gap > maxGap) {
      return { ok: false, reason: 'gap_too_wide' };
    }
  }

  const hazards = level.tiles.filter((tile) => tile.type === 'hazard');
  for (const hazard of hazards) {
    const hasWindow = walkable.some((tile) => {
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

export interface TestLevelResult {
  ok: boolean;
  path?: InputCmd[];
  reason?: string;
  nodes?: number;
  durationMs?: number;
}

function mapSearchReason(reason?: string): string {
  if (!reason) {
    return 'no_path';
  }
  if (reason === 'timeout' || reason === 'node_limit') {
    return 'timeout';
  }
  if (reason === 'no_spawn') {
    return 'no_spawn';
  }
  return 'no_path';
}

export async function testLevel(level: LevelT): Promise<TestLevelResult> {
  const precheck = runPrechecks(level);
  if (!precheck.ok) {
    return { ok: false, reason: precheck.reason };
  }

  const search = findPath(level, 3000, 80000);
  if (!search.ok || !search.path) {
    return {
      ok: false,
      reason: mapSearchReason(search.reason),
      nodes: search.nodes,
      durationMs: search.ms,
    };
  }

  const path = compressPath(search.path);
  const simulation = simulate(level, path);
  if (!simulation.ok) {
    return {
      ok: false,
      reason: 'no_path',
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
