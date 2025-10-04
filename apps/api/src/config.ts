import { resolveQueueConfig } from '@ir/queue-config';
import { z } from 'zod';

const DEFAULT_DB_PATH = './data/app.db';

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.string().optional(),
  HOST: z.string().optional(),
  REDIS_URL: z.string().optional(),
  DB_PATH: z.string().optional(),
  ORIGIN_ALLOW: z.string().optional(),
  RATE_WINDOW_MS: z.string().optional(),
  RATE_MAX: z.string().optional(),
  RATE_MAX_SEASON: z.string().optional(),
  RATE_WINDOW_SEASON_MS: z.string().optional(),
  INTERNAL_TOKEN: z.string().optional(),
  BUDGET_USD_PER_DAY: z.string().optional(),
  QUEUE_PREFIX: z.string().optional(),
  BATCH_COUNT_MAX: z.string().optional(),
  MAX_PARALLEL_JOBS: z.string().optional(),
  JOB_QUEUE_BACKPRESSURE_MS: z.string().optional(),
  REQUEST_BODY_LIMIT_BYTES: z.string().optional(),
  BATCH_TTL_DAYS: z.string().optional(),
  BATCH_RATE_MAX: z.string().optional(),
  BATCH_RATE_WINDOW_MS: z.string().optional(),
});

export interface AppConfig {
  nodeEnv: string;
  port: number;
  host: string;
  redisUrl: string;
  databasePath: string;
  originAllowList: string[];
  rateLimit: {
    windowMs: number;
    max: number;
    seasonMax: number;
    seasonWindowMs: number;
  };
  batch: {
    countMax: number;
    maxParallelJobs: number;
    jobQueueBackpressureMs: number;
    requestBodyLimitBytes: number;
    ttlDays: number;
    rateLimit: {
      windowMs: number;
      max: number;
    };
  };
  queue: {
    prefix: string;
    budgetUsdPerDay: number | null;
  };
  internalToken: string | undefined;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBudget(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function normalisePath(value: string | undefined): string {
  if (!value) {
    return DEFAULT_DB_PATH;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_DB_PATH;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const nodeEnv = parsed.NODE_ENV ?? 'development';

  const port = parseInteger(parsed.PORT, 3000);
  const host = parsed.HOST?.trim() ?? '0.0.0.0';
  const redisUrl = parsed.REDIS_URL?.trim() ?? 'redis://localhost:6379';
  const databasePath = normalisePath(parsed.DB_PATH);

  const originAllowList = (parsed.ORIGIN_ALLOW ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const rateLimit = {
    windowMs: parseInteger(parsed.RATE_WINDOW_MS, 60_000),
    max: parseInteger(parsed.RATE_MAX, 30),
    seasonMax: parseInteger(parsed.RATE_MAX_SEASON, 2),
    seasonWindowMs: parseInteger(parsed.RATE_WINDOW_SEASON_MS, 600_000),
  };

  const batchRateLimit = {
    windowMs: parseInteger(parsed.BATCH_RATE_WINDOW_MS, 60_000),
    max: parseInteger(parsed.BATCH_RATE_MAX, 5),
  };

  const safePositive = (value: number, fallback: number): number => {
    if (!Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return value;
  };

  const batch = {
    countMax: safePositive(parseInteger(parsed.BATCH_COUNT_MAX, 1_000), 1_000),
    maxParallelJobs: safePositive(parseInteger(parsed.MAX_PARALLEL_JOBS, 8), 8),
    jobQueueBackpressureMs: safePositive(parseInteger(parsed.JOB_QUEUE_BACKPRESSURE_MS, 100), 100),
    requestBodyLimitBytes: safePositive(
      parseInteger(parsed.REQUEST_BODY_LIMIT_BYTES, 64 * 1024),
      64 * 1024,
    ),
    ttlDays: safePositive(parseInteger(parsed.BATCH_TTL_DAYS, 30), 30),
    rateLimit: batchRateLimit,
  };

  const queueConfig = resolveQueueConfig({ prefix: parsed.QUEUE_PREFIX });

  const normalizedToken = parsed.INTERNAL_TOKEN?.trim();
  const internalToken =
    normalizedToken && normalizedToken.length > 0
      ? normalizedToken
      : nodeEnv === 'production'
        ? undefined
        : 'dev-internal';

  return {
    nodeEnv,
    port,
    host,
    redisUrl,
    databasePath,
    originAllowList,
    rateLimit,
    batch,
    queue: {
      prefix: queueConfig.prefix,
      budgetUsdPerDay: parseBudget(parsed.BUDGET_USD_PER_DAY),
    },
    internalToken,
  };
}

export function requireProdSecrets(config: AppConfig): void {
  if (config.nodeEnv === 'production' && !config.internalToken) {
    throw new Error('INTERNAL_TOKEN must be set in production');
  }
}
