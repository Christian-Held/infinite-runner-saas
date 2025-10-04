import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type IORedis from 'ioredis';
import Redis from 'ioredis-mock';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { closeDb, openDb, findBatchById, insertLevel, listBatchJobs, updateJobStatus } from './db';
import { buildServer } from './server';
import type { QueueManager } from './queue';

function createQueueManagerStub(): QueueManager {
  return {
    enqueueGen: vi.fn().mockResolvedValue('job'),
    enqueuePreparedGenJobs: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getQueueOverview: vi.fn().mockResolvedValue({
      gen: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      test: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    }),
    getBudgetStatus: vi
      .fn()
      .mockResolvedValue({ limitUsd: null, remainingUsd: Number.POSITIVE_INFINITY, ok: true }),
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

  it('creates a batch and enqueues jobs', async () => {
    const dbPath = path.join(tempDir, 'app.db');
    const db = openDb(dbPath);
    await migrate(db);

    const queueManager = createQueueManagerStub();
    const enqueueSpy = queueManager.enqueuePreparedGenJobs as unknown as ReturnType<typeof vi.fn>;
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

    const response = await server.inject({
      method: 'POST',
      url: '/levels/generate-batch',
      payload: {
        count: 2,
        start_level: 5,
        seed_prefix: 'demo',
        difficulty_mode: 'fixed',
        difficulty_fixed: 3,
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { batch_id: string; job_ids: string[]; count: number };
    expect(body.count).toBe(2);
    expect(body.job_ids).toHaveLength(2);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    const stored = findBatchById(body.batch_id);
    expect(stored).not.toBeNull();
    const jobs = listBatchJobs(body.batch_id);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.seed).toContain('demo');

    await server.close();
    redis.disconnect();
  });

  it('reuses batches when idempotency key matches', async () => {
    const dbPath = path.join(tempDir, 'app.db');
    const db = openDb(dbPath);
    await migrate(db);

    const queueManager = createQueueManagerStub();
    const enqueueSpy = queueManager.enqueuePreparedGenJobs as unknown as ReturnType<typeof vi.fn>;
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

    const payload = { count: 1, idempotency_key: 'same-key', seed_prefix: 'reuse' };
    const first = await server.inject({ method: 'POST', url: '/levels/generate-batch', payload });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as { batch_id: string; job_ids: string[]; count: number };
    expect(firstBody.job_ids).toHaveLength(1);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    const second = await server.inject({ method: 'POST', url: '/levels/generate-batch', payload });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { batch_id: string; job_ids: string[]; count: number };
    expect(secondBody.batch_id).toBe(firstBody.batch_id);
    expect(secondBody.job_ids).toEqual(firstBody.job_ids);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    await server.close();
    redis.disconnect();
  });

  it('aggregates batch status for detail view', async () => {
    const dbPath = path.join(tempDir, 'app.db');
    const db = openDb(dbPath);
    await migrate(db);

    const queueManager = createQueueManagerStub();
    const enqueueSpy = queueManager.enqueuePreparedGenJobs as unknown as ReturnType<typeof vi.fn>;
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

    const response = await server.inject({
      method: 'POST',
      url: '/levels/generate-batch',
      payload: { count: 2, seed_prefix: 'metrics', difficulty_mode: 'fixed', difficulty_fixed: 2 },
    });
    expect(response.statusCode).toBe(202);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const body = response.json() as { batch_id: string; job_ids: string[] };
    expect(body.job_ids).toHaveLength(2);

    insertLevel(
      {
        id: 'lvl-success',
        seed: 'seed-success',
        rules: {
          abilities: { run: true, jump: true },
          duration_target_s: 60,
          difficulty: 2,
        },
        tiles: [],
        moving: [],
        items: [],
        enemies: [],
        checkpoints: [],
        exit: { x: 0, y: 0 },
      },
      { difficulty: 2, seed: 'seed-success' },
    );

    updateJobStatus(body.job_ids[0] ?? '', 'succeeded', { levelId: 'lvl-success' });
    updateJobStatus(body.job_ids[1] ?? '', 'failed', { error: 'boom' });

    const detail = await server.inject({ method: 'GET', url: `/batches/${body.batch_id}` });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as {
      status: string;
      metrics: { succeeded: number; failed: number; total: number };
      levels: string[];
      errors: Array<{ job_id: string }>;
    };
    expect(detailBody.metrics.total).toBe(2);
    expect(detailBody.metrics.succeeded).toBe(1);
    expect(detailBody.metrics.failed).toBe(1);
    expect(detailBody.levels).toContain('lvl-success');
    expect(detailBody.errors).toHaveLength(1);

    await server.close();
    redis.disconnect();
  });
});
