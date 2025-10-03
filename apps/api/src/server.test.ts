import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type IORedis from 'ioredis';
import Redis from 'ioredis-mock';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { closeDb, openDb } from './db';
import { buildServer } from './server';
import type { QueueManager } from './queue';

function createQueueManagerStub(): QueueManager {
  return {
    enqueueGen: vi.fn().mockResolvedValue('job'),
    isHealthy: vi.fn().mockResolvedValue(true),
    getQueueOverview: vi.fn().mockResolvedValue({
      gen: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      test: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    }),
    getBudgetStatus: vi.fn().mockResolvedValue({ limitUsd: null, remainingUsd: Number.POSITIVE_INFINITY, ok: true }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createTestLogger() {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

describe('server', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'api-tests-'));
    closeDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an empty level list when no levels exist', async () => {
    const dbPath = path.join(tempDir, 'app.db');
    const db = openDb(dbPath);
    await migrate(db);

    const queueManager = createQueueManagerStub();
    const redis = new (Redis as unknown as { new (): IORedis })();
    const logger = createTestLogger();

    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      REDIS_URL: 'redis://localhost:6379',
      DB_PATH: dbPath,
      INTERNAL_TOKEN: 'test-token',
    });

    const server = buildServer({
      db,
      redis,
      queueManager,
      logger: logger as never,
      config,
      internalToken: config.internalToken ?? 'dev-internal',
    });

    await server.ready();
    const response = await server.inject({ method: 'GET', url: '/levels' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ levels: [] });

    await server.close();
    redis.disconnect();
  });
});
