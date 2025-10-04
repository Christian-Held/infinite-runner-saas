import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, requireProdSecrets } from './config';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('config', () => {
  it('defaults internal token and queue config in development', () => {
    delete process.env.INTERNAL_TOKEN;
    delete process.env.QUEUE_PREFIX;
    process.env.NODE_ENV = 'development';

    const config = loadConfig();

    expect(config.internalToken).toBe('dev-internal');
    expect(config.queue.prefix).toBe('bull');
    expect(config.queue.budgetUsdPerDay).toBeNull();
    expect(config.batch.countMax).toBeGreaterThan(0);
    expect(config.batch.maxParallelJobs).toBeGreaterThan(0);
    expect(config.batch.rateLimit.max).toBeGreaterThan(0);
    expect(() => requireProdSecrets(config)).not.toThrow();
  });

  it('requires internal token in production', () => {
    delete process.env.INTERNAL_TOKEN;
    process.env.NODE_ENV = 'production';

    const config = loadConfig();

    expect(config.internalToken).toBeUndefined();
    expect(() => requireProdSecrets(config)).toThrowError(
      'INTERNAL_TOKEN must be set in production',
    );
  });

  it('respects provided internal token and budget configuration', () => {
    process.env.NODE_ENV = 'production';
    process.env.INTERNAL_TOKEN = 'super-secret';
    process.env.BUDGET_USD_PER_DAY = '12.5';
    process.env.QUEUE_PREFIX = 'staging';

    const config = loadConfig();

    expect(config.internalToken).toBe('super-secret');
    expect(config.queue.budgetUsdPerDay).toBe(12.5);
    expect(config.queue.prefix).toBe('staging');
    expect(config.batch.countMax).toBeGreaterThan(0);
    expect(() => requireProdSecrets(config)).not.toThrow();
  });

  it('trims whitespace from provided tokens in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_TOKEN = '  trimmed  ';

    const config = loadConfig();

    expect(config.internalToken).toBe('trimmed');
  });

  it('treats blank budgets as disabled', () => {
    process.env.NODE_ENV = 'development';
    process.env.BUDGET_USD_PER_DAY = ' 0 ';

    const config = loadConfig();

    expect(config.queue.budgetUsdPerDay).toBeNull();
  });

  it('ignores whitespace-only budget entries', () => {
    process.env.NODE_ENV = 'development';
    process.env.BUDGET_USD_PER_DAY = '   ';

    const config = loadConfig();

    expect(config.queue.budgetUsdPerDay).toBeNull();
  });
});
