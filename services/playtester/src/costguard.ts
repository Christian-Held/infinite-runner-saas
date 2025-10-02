import { getRedisClient } from './clients';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

const BUDGET_ENV = process.env.BUDGET_USD_PER_DAY;

if (!BUDGET_ENV) {
  throw new Error('BUDGET_USD_PER_DAY is required for cost guard');
}

const BUDGET_USD_PER_DAY = Number.parseFloat(BUDGET_ENV);
if (!Number.isFinite(BUDGET_USD_PER_DAY) || BUDGET_USD_PER_DAY <= 0) {
  throw new Error('BUDGET_USD_PER_DAY must be a positive number');
}

const COST_PER_1K_INPUT = Number.parseFloat(process.env.COST_PER_1K_INPUT ?? '0');
const COST_PER_1K_OUTPUT = Number.parseFloat(process.env.COST_PER_1K_OUTPUT ?? '0');

if (!Number.isFinite(COST_PER_1K_INPUT) || !Number.isFinite(COST_PER_1K_OUTPUT)) {
  throw new Error('COST_PER_1K_INPUT and COST_PER_1K_OUTPUT must be finite numbers');
}

function formatKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `cost:day:${year}${month}${day}`;
}

function calculateUsd(usage: Usage): number {
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  const inputUsd = (input / 1000) * COST_PER_1K_INPUT;
  const outputUsd = (output / 1000) * COST_PER_1K_OUTPUT;
  return inputUsd + outputUsd;
}

function secondsUntilEndOfDay(date: Date): number {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  const diffMs = end.getTime() - date.getTime();
  return Math.max(1, Math.ceil(diffMs / 1000));
}

export async function trackAndCheck(
  usage: Usage,
): Promise<{ ok: boolean; remainingUsd: number }> {
  const redis = getRedisClient();
  const now = new Date();
  const key = formatKey(now);
  const increment = calculateUsd(usage);
  let total = increment;

  if (increment !== 0) {
    const updated = await redis.incrbyfloat(key, increment);
    total = Number.parseFloat(typeof updated === 'string' ? updated : String(updated));
  } else {
    const existing = await redis.get(key);
    total = existing ? Number.parseFloat(existing) : 0;
  }

  const ttl = secondsUntilEndOfDay(now);
  if (ttl > 0) {
    await redis.expire(key, ttl);
  }

  const remaining = Math.max(0, BUDGET_USD_PER_DAY - total);
  return { ok: total <= BUDGET_USD_PER_DAY, remainingUsd: remaining };
}
