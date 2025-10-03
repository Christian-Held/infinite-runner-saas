import type { AbilityT } from './index';

export type LevelPlan = {
  levelNumber: number;
  difficultyTarget: number;
  difficultyBand: [number, number];
  abilities: AbilityT;
  constraints: {
    maxGapPX: number;
    minPlatformWidthPX: number;
    maxStepUpPX: number;
    movingMax?: number;
    enemyMax?: number;
    hazardMax?: number;
    jetpack?: { fuel: number; thrust: number };
  };
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * clamp(t, 0, 1);
}

function roundLerp(min: number, max: number, t: number): number {
  return Math.round(lerp(min, max, t));
}

function jetpackFuel(level: number, startLevel: number, endLevel: number, minFuel: number, maxFuel: number): number {
  const range = endLevel - startLevel;
  const t = range <= 0 ? 1 : (level - startLevel) / range;
  return Math.round(lerp(minFuel, maxFuel, t));
}

function baseAbilities(level: number): AbilityT {
  const abilities: AbilityT = {
    run: true,
    jump: true,
  };

  if (level >= 11) {
    abilities.highJump = true;
  }
  if (level >= 31) {
    abilities.shortFly = true;
  }
  if (level >= 41) {
    if (!abilities.highJump) {
      abilities.highJump = true;
    }
    abilities.shortFly = true;
    let fuel = 20;
    if (level <= 60) {
      fuel = jetpackFuel(level, 41, 60, 20, 40);
    } else if (level <= 80) {
      fuel = jetpackFuel(level, 61, 80, 40, 60);
    } else {
      fuel = jetpackFuel(level, 81, 100, 60, 90);
    }
    abilities.jetpack = { fuel, thrust: 640 };
  }

  return abilities;
}

function bandForLevel(level: number): [number, number] {
  if (level <= 10) {
    return [1, 10];
  }
  if (level <= 30) {
    return [11, 30];
  }
  if (level <= 40) {
    return [31, 40];
  }
  if (level <= 60) {
    return [41, 60];
  }
  if (level <= 80) {
    return [61, 80];
  }
  return [81, 100];
}

function movingMaxForLevel(level: number): number {
  if (level <= 10) {
    return roundLerp(0, 1, (level - 1) / 9);
  }
  if (level <= 30) {
    return roundLerp(1, 2, (level - 11) / 19);
  }
  if (level <= 40) {
    return roundLerp(2, 3, (level - 31) / 9);
  }
  if (level <= 60) {
    return roundLerp(3, 4, (level - 41) / 19);
  }
  if (level <= 80) {
    return roundLerp(4, 5, (level - 61) / 19);
  }
  return roundLerp(5, 6, (level - 81) / 19);
}

function enemyMaxForLevel(level: number): number {
  if (level <= 10) {
    return 0;
  }
  if (level <= 30) {
    return roundLerp(0, 2, (level - 11) / 19);
  }
  if (level <= 40) {
    return roundLerp(1, 3, (level - 31) / 9);
  }
  if (level <= 60) {
    return roundLerp(2, 4, (level - 41) / 19);
  }
  if (level <= 80) {
    return roundLerp(3, 5, (level - 61) / 19);
  }
  return roundLerp(4, 6, (level - 81) / 19);
}

function hazardMaxForLevel(level: number): number {
  if (level <= 10) {
    return roundLerp(0, 1, (level - 1) / 9);
  }
  if (level <= 30) {
    return roundLerp(1, 3, (level - 11) / 19);
  }
  if (level <= 40) {
    return roundLerp(2, 4, (level - 31) / 9);
  }
  if (level <= 60) {
    return roundLerp(3, 5, (level - 41) / 19);
  }
  if (level <= 80) {
    return roundLerp(4, 6, (level - 61) / 19);
  }
  return roundLerp(5, 8, (level - 81) / 19);
}

function normalizeLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return 1;
  }
  return clamp(Math.round(level), 1, 100);
}

export function getLevelPlan(level: number): LevelPlan {
  const levelNumber = normalizeLevel(level);
  const difficultyTarget = levelNumber;
  const difficultyBand = bandForLevel(levelNumber);
  const abilities = baseAbilities(levelNumber);

  const constraints: LevelPlan['constraints'] = {
    maxGapPX: clamp(120 + levelNumber * 0.8, 120, 220),
    minPlatformWidthPX: clamp(48 - levelNumber * 0.1, 36, 48),
    maxStepUpPX: clamp(96 + levelNumber * 0.2, 96, 140),
    movingMax: movingMaxForLevel(levelNumber),
    enemyMax: enemyMaxForLevel(levelNumber),
    hazardMax: hazardMaxForLevel(levelNumber),
  };

  if (abilities.jetpack) {
    constraints.jetpack = { ...abilities.jetpack };
  }

  return {
    levelNumber,
    difficultyTarget,
    difficultyBand,
    abilities,
    constraints,
  };
}
