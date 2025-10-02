import { LevelT } from '@ir/game-spec';

const GAP_MAX_PX = 220;
const AVG_GAP_MAX_PX = 180;

const K1 = 2;
const K2 = 3;
const K3 = 0.5;
const K4 = 0.02;
const K5 = 0.01;
const K6 = 4;

interface GapStats {
  maxGap: number;
  avgGap: number;
}

function collectWalkableTiles(level: LevelT) {
  return level.tiles
    .filter((tile) => tile.type === 'ground' || tile.type === 'platform')
    .sort((a, b) => a.x - b.x);
}

function computeGapStats(level: LevelT): GapStats {
  const tiles = collectWalkableTiles(level);
  if (tiles.length < 2) {
    return { maxGap: 0, avgGap: 0 };
  }

  let maxGap = 0;
  let sumGap = 0;
  let gaps = 0;

  for (let i = 0; i < tiles.length - 1; i += 1) {
    const current = tiles[i];
    const next = tiles[i + 1];
    const gap = next.x - (current.x + current.w);
    if (gap <= 0) {
      continue;
    }
    gaps += 1;
    sumGap += gap;
    if (gap > maxGap) {
      maxGap = gap;
    }
  }

  const avgGap = gaps > 0 ? sumGap / gaps : 0;
  return { maxGap, avgGap };
}

function computeStdDev(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function computeVerticality(level: LevelT): number {
  const tiles = collectWalkableTiles(level);
  const yValues = tiles.map((tile) => tile.y);
  return computeStdDev(yValues);
}

function computeHazardExposure(level: LevelT): number {
  return level.tiles
    .filter((tile) => tile.type === 'hazard')
    .reduce((sum, tile) => sum + tile.w, 0);
}

function computeMovingTightness(level: LevelT): number {
  return level.moving.filter((platform) => {
    const [fromX, fromY] = platform.from;
    const [toX, toY] = platform.to;
    const travelDistance = Math.hypot(toX - fromX, toY - fromY);
    const windowMs = platform.period_ms;
    if (travelDistance <= 0) {
      return false;
    }
    if (windowMs <= 2600) {
      return true;
    }
    return travelDistance > 180 && windowMs <= 3600;
  }).length;
}

export function scoreLevel(level: LevelT): number {
  const { maxGap, avgGap } = computeGapStats(level);
  const normalizedMaxGap = Math.min(maxGap / GAP_MAX_PX, 1);
  const normalizedAvgGap = Math.min(avgGap / AVG_GAP_MAX_PX, 1);
  const gapScore = normalizedMaxGap * 40 + normalizedAvgGap * 20;

  const movingScore = K1 * (level.moving?.length ?? 0);

  const enemyCount = level.enemies?.length ?? 0;
  const avgEnemySpeed =
    enemyCount > 0 ? level.enemies.reduce((sum, enemy) => sum + enemy.speed, 0) / enemyCount : 0;
  const enemyScore = K2 * enemyCount + K3 * avgEnemySpeed;

  const verticalityScore = K4 * computeVerticality(level);
  const hazardScore = K5 * computeHazardExposure(level);
  const timingScore = K6 * computeMovingTightness(level);

  const score = gapScore + movingScore + enemyScore + verticalityScore + hazardScore + timingScore;
  return Number.isFinite(score) ? Math.max(score, 0) : 0;
}

export function withinBand(score: number, band: [number, number]): boolean {
  if (!Number.isFinite(score)) {
    return false;
  }
  const [min, max] = band;
  const tolerance = 0.1;
  const lower = min * (1 - tolerance);
  const upper = max * (1 + tolerance);
  return score >= lower && score <= upper;
}
