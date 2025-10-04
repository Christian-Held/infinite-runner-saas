import 'dotenv/config';

export const cfg = {
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  bullPrefix: process.env.BULL_PREFIX ?? 'bull',
  genQueue: process.env.GEN_QUEUE ?? 'gen',
  testQueue: process.env.TEST_QUEUE ?? 'test',
  apiBase: process.env.API_BASE_URL ?? 'http://localhost:3000',
  internalToken: process.env.INTERNAL_TOKEN ?? 'dev-internal',
  openaiKey: process.env.OPENAI_API_KEY,
  budgetUsdPerDay: Number(process.env.BUDGET_USD_PER_DAY ?? '5'),
  costPer1kInput: Number(process.env.COST_PER_1K_INPUT ?? '0'),
  costPer1kOutput: Number(process.env.COST_PER_1K_OUTPUT ?? '0'),
} as const;

export type Config = typeof cfg;
