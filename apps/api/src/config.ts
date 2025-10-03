import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.string().optional(),
  HOST: z.string().optional(),
  REDIS_URL: z.string().optional(),
  ORIGIN_ALLOW: z.string().optional(),
  RATE_WINDOW_MS: z.string().optional(),
  RATE_MAX: z.string().optional(),
  RATE_MAX_SEASON: z.string().optional(),
  RATE_WINDOW_SEASON_MS: z.string().optional(),
  INTERNAL_TOKEN: z.string().optional(),
});

export interface AppConfig {
  nodeEnv: string;
  port: number;
  host: string;
  redisUrl: string;
  originAllowList: string[];
  rateLimit: {
    windowMs: number;
    max: number;
    seasonMax: number;
    seasonWindowMs: number;
  };
  internalToken: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const nodeEnv = parsed.NODE_ENV ?? 'development';
  const port = Number.parseInt(parsed.PORT ?? '3000', 10);
  const host = parsed.HOST ?? '0.0.0.0';
  const redisUrl = parsed.REDIS_URL ?? 'redis://localhost:6379';
  const originAllowList = (parsed.ORIGIN_ALLOW ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const toInteger = (value: string | undefined, fallback: number): number => {
    const parsedValue = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsedValue) ? parsedValue : fallback;
  };

  const rateLimit = {
    windowMs: toInteger(parsed.RATE_WINDOW_MS, 60_000),
    max: toInteger(parsed.RATE_MAX, 30),
    seasonMax: toInteger(parsed.RATE_MAX_SEASON, 2),
    seasonWindowMs: toInteger(parsed.RATE_WINDOW_SEASON_MS, 600_000),
  };

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
    originAllowList,
    rateLimit,
    internalToken,
  };
}

export function requireProdSecrets(config: AppConfig): void {
  if (config.nodeEnv === 'production' && !config.internalToken) {
    throw new Error('INTERNAL_TOKEN must be set in production');
  }
}
