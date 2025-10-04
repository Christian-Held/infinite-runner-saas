import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('config loader', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.REDIS_URL;
    delete process.env.BULL_PREFIX;
    delete process.env.GEN_QUEUE;
    delete process.env.TEST_QUEUE;
    delete process.env.API_BASE_URL;
    delete process.env.INTERNAL_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.BUDGET_USD_PER_DAY;
    delete process.env.COST_PER_1K_INPUT;
    delete process.env.COST_PER_1K_OUTPUT;
  });

  it('provides development defaults when env is missing', async () => {
    const { cfg } = await import('../src/config');
    expect(cfg.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(cfg.bullPrefix).toBe('bull');
    expect(cfg.genQueue).toBe('gen');
    expect(cfg.testQueue).toBe('test');
    expect(cfg.apiBase).toBe('http://localhost:3000');
    expect(cfg.internalToken).toBe('dev-internal');
    expect(cfg.openaiKey).toBeUndefined();
    expect(cfg.budgetUsdPerDay).toBe(5);
    expect(cfg.costPer1kInput).toBe(0);
    expect(cfg.costPer1kOutput).toBe(0);
  });

  it('respects environment overrides', async () => {
    process.env.REDIS_URL = 'redis://example:1234';
    process.env.BULL_PREFIX = 'custom';
    process.env.GEN_QUEUE = 'genq';
    process.env.TEST_QUEUE = 'testq';
    process.env.API_BASE_URL = 'http://api.local';
    process.env.INTERNAL_TOKEN = 'token';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.BUDGET_USD_PER_DAY = '10';
    process.env.COST_PER_1K_INPUT = '1.5';
    process.env.COST_PER_1K_OUTPUT = '2.5';

    const { cfg } = await import('../src/config');
    expect(cfg.redisUrl).toBe('redis://example:1234');
    expect(cfg.bullPrefix).toBe('custom');
    expect(cfg.genQueue).toBe('genq');
    expect(cfg.testQueue).toBe('testq');
    expect(cfg.apiBase).toBe('http://api.local');
    expect(cfg.internalToken).toBe('token');
    expect(cfg.openaiKey).toBe('sk-test');
    expect(cfg.budgetUsdPerDay).toBe(10);
    expect(cfg.costPer1kInput).toBe(1.5);
    expect(cfg.costPer1kOutput).toBe(2.5);
  });
});
