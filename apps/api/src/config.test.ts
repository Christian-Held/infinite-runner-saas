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
  it('defaults internal token in development', () => {
    delete process.env.INTERNAL_TOKEN;
    process.env.NODE_ENV = 'development';

    const config = loadConfig();

    expect(config.internalToken).toBe('dev-internal');
    expect(() => requireProdSecrets(config)).not.toThrow();
  });

  it('requires internal token in production', () => {
    delete process.env.INTERNAL_TOKEN;
    process.env.NODE_ENV = 'production';

    const config = loadConfig();

    expect(config.internalToken).toBeUndefined();
    expect(() => requireProdSecrets(config)).toThrowError('INTERNAL_TOKEN must be set in production');
  });

  it('respects provided internal token in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.INTERNAL_TOKEN = 'super-secret';

    const config = loadConfig();

    expect(config.internalToken).toBe('super-secret');
    expect(() => requireProdSecrets(config)).not.toThrow();
  });
});
