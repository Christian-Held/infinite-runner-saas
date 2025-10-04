import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('queue error handling', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.OPENAI_API_KEY;
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.QUEUE_PREFIX = 'testbull';
    process.env.BULL_PREFIX = 'legacy-bull';
    process.env.GEN_QUEUE = 'gen';
    process.env.TEST_QUEUE = 'test';
    process.env.API_BASE_URL = 'http://localhost:3000';
    process.env.INTERNAL_TOKEN = 'secret';
  });

  afterEach(async () => {
    try {
      const { stopWorkers } = await import('../src/queue');
      await stopWorkers();
    } catch {
      // Module may not have been imported in tests that fail before start.
    }
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  function mockInfrastructure({
    trackAndCheckResult = { ok: true },
    fetchJsonImpl,
  }: {
    trackAndCheckResult?: unknown;
    fetchJsonImpl?: ReturnType<typeof vi.fn>;
  } = {}) {
    const fetchJson = fetchJsonImpl ?? vi.fn().mockResolvedValue({});

    vi.doMock('../src/http', () => ({ fetchJson }));
    vi.doMock('../src/generator', () => ({
      generateLevel: vi.fn(),
      closeGenerator: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/tester', () => ({ testLevel: vi.fn() }));
    vi.doMock('../src/scoring', () => ({ scoreLevel: vi.fn() }));
    vi.doMock('../src/costguard', () => ({ trackAndCheck: vi.fn().mockResolvedValue(trackAndCheckResult) }));

    vi.doMock('ioredis', () => {
      const ctor = vi.fn();
      class FakeRedis extends EventEmitter {
        quit = vi.fn().mockResolvedValue(undefined);
        disconnect = vi.fn();
        constructor(public readonly url: string, public readonly options?: unknown) {
          super();
          ctor(url, options);
        }
      }
      return { __esModule: true, default: FakeRedis, __ctor: ctor };
    });

    const workerCalls: Array<{ name: string; processor: (job: any) => Promise<unknown>; options: unknown }> = [];

    vi.doMock('bullmq', () => {
      class FakeQueue<T> {
        add = vi.fn().mockResolvedValue(undefined);
        close = vi.fn().mockResolvedValue(undefined);
        constructor(public readonly name: string, public readonly options: unknown) {}
      }

      class FakeWorker<T> {
        close = vi.fn().mockResolvedValue(undefined);
        constructor(
          public readonly name: string,
          public readonly processor: (job: { id: string; data: T }) => Promise<unknown>,
          public readonly options: unknown,
        ) {
          workerCalls.push({ name, processor, options });
        }
        on() {
          return this;
        }
      }

      class FakeQueueEvents {
        close = vi.fn().mockResolvedValue(undefined);
        constructor(public readonly name: string, public readonly options: unknown) {}
        on() {
          return this;
        }
      }

      return {
        __esModule: true,
        Queue: FakeQueue,
        Worker: FakeWorker,
        QueueEvents: FakeQueueEvents,
        workerCalls,
      };
    });

    return { fetchJson, workerCalls };
  }

  it('fails fast when OPENAI_API_KEY is missing', async () => {
    mockInfrastructure();
    const { startWorkers } = await import('../src/queue');
    await expect(startWorkers()).rejects.toThrow('OPENAI_API_KEY');

    const redisModule = (await import('ioredis')) as unknown as { __ctor: ReturnType<typeof vi.fn> };
    expect(redisModule.__ctor).not.toHaveBeenCalled();
  });

  it('marks gen job as failed when budget is exceeded', async () => {
    process.env.OPENAI_API_KEY = 'key';
    const statusUpdates: Array<{ path?: string; body?: unknown }> = [];
    const fetchJson = vi.fn().mockImplementation(async (request: { path: string; body?: unknown }) => {
      if (request.path.includes('/internal/jobs')) {
        statusUpdates.push(request);
      }
      return {};
    });

    const { workerCalls } = mockInfrastructure({ trackAndCheckResult: { ok: false }, fetchJsonImpl: fetchJson });
    const { startWorkers } = await import('../src/queue');
    await startWorkers();

    const genWorker = workerCalls.find((call) => call.name === 'gen');
    expect(genWorker).toBeDefined();

    await expect(
      genWorker?.processor({ id: 'gen-1', data: { jobId: 'job-1', seed: 'seed-1' } }),
    ).rejects.toThrow('budget_exceeded');

    expect(statusUpdates.some((entry) => entry.body && (entry.body as { status?: string }).status === 'failed')).toBe(true);
  });
});
