import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LevelT } from '@ir/game-spec';

const failingLevel: LevelT = {
  id: 'lvl-error',
  seed: 'seed-error',
  rules: {
    abilities: { run: true, jump: true },
    duration_target_s: 60,
    difficulty: 2,
  },
  tiles: [
    { x: 0, y: 200, w: 400, h: 20, type: 'ground' },
    { x: 420, y: 180, w: 120, h: 20, type: 'platform' },
  ],
  moving: [],
  items: [],
  enemies: [],
  checkpoints: [],
  exit: { x: 520, y: 160 },
};

vi.mock('ioredis', async () => {
  const mod = await import('ioredis-mock');
  const RedisMock = mod.default;
  class WrappedRedis extends RedisMock {
    constructor(...args: unknown[]) {
      super(...(args as []));
      this.options = { ...(this.options ?? {}), keyPrefix: '' };
    }
  }
  return { default: WrappedRedis };
});

vi.mock('bullmq', () => {
  type JobStatus = 'waiting' | 'completed' | 'failed';
  interface FakeJob<T> {
    id: string;
    name: string;
    data: T;
    status: JobStatus;
    returnvalue?: unknown;
    failedReason?: string;
  }

  const queues = new Map<string, FakeQueue<unknown>>();
  const workers = new Map<string, FakeWorker<unknown>>();

  class FakeQueue<T> {
    public jobs: FakeJob<T>[] = [];
    constructor(public readonly name: string) {
      const existing = queues.get(name);
      if (existing) {
        return existing as unknown as FakeQueue<T>;
      }
      queues.set(name, this as unknown as FakeQueue<unknown>);
    }

    async add(jobName: string, data: T, opts?: { jobId?: string }) {
      const id = opts?.jobId ?? Math.random().toString(36).slice(2);
      const job: FakeJob<T> = { id, name: jobName, data, status: 'waiting' };
      this.jobs.push(job);
      setImmediate(() => {
        const worker = workers.get(this.name);
        if (worker) {
          worker.run(job as unknown as FakeJob<unknown>);
        }
      });
      return job as unknown as { id: string; data: T };
    }

    async getJobCounts() {
      return {
        waiting: this.jobs.filter((job) => job.status === 'waiting').length,
        active: 0,
        completed: this.jobs.filter((job) => job.status === 'completed').length,
        failed: this.jobs.filter((job) => job.status === 'failed').length,
        delayed: 0,
      };
    }

    async getJob(id: string) {
      return this.jobs.find((job) => job.id === id) ?? null;
    }

    async close() {
      queues.delete(this.name);
    }
  }

  class FakeWorker<T> {
    constructor(
      private readonly queueName: string,
      private readonly processor: (job: { id: string; data: T }) => Promise<unknown>,
    ) {
      workers.set(queueName, this as unknown as FakeWorker<unknown>);
      const queue = queues.get(queueName);
      if (queue) {
        queue.jobs
          .filter((job) => job.status === 'waiting')
          .forEach((job) => this.run(job));
      }
    }

    async run(job: FakeJob<unknown>) {
      try {
        const result = await this.processor(job as unknown as { id: string; data: T });
        job.status = 'completed';
        job.returnvalue = result;
      } catch (error) {
        job.status = 'failed';
        job.failedReason = error instanceof Error ? error.message : String(error);
      }
    }

    on() {
      return this;
    }

    async close() {
      workers.delete(this.queueName);
    }
  }

  class FakeQueueEvents {
    on() {
      return this;
    }
    async close() {
      return;
    }
  }

  return { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents };
});

describe('queue error handling', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.BULL_PREFIX = 'testbull';
    process.env.GEN_QUEUE = 'gen';
    process.env.TEST_QUEUE = 'test';
    process.env.API_BASE_URL = 'http://localhost:3000';
    process.env.INTERNAL_TOKEN = 'secret';
    process.env.BUDGET_USD_PER_DAY = '5';
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(async () => {
    const { stopWorkers } = await import('../src/queue');
    await stopWorkers();
    vi.clearAllMocks();
  });

  it('fails generation job when OpenAI key missing', async () => {
    vi.doMock('../src/generator', async () => {
      const actual = await vi.importActual<typeof import('../src/generator')>('../src/generator');
      return actual;
    });

    vi.doMock('../src/tester', () => ({
      testLevel: vi.fn(async () => {
        throw new Error('should not run');
      }),
    }));

    const statusUpdates: Array<{ pathname: string; body: unknown }> = [];

    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const pathname = new URL(url).pathname;
      if (pathname.startsWith('/internal/jobs/') && pathname.endsWith('/status')) {
        statusUpdates.push({ pathname, body: init?.body ? JSON.parse(init.body as string) : null });
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${method} ${pathname}`);
    });

    const { cfg } = await import('../src/config');
    const { startWorkers } = await import('../src/queue');
    await startWorkers();

    const { Queue } = await import('bullmq');
    const Redis = (await import('ioredis-mock')).default;
    const connection = new Redis();
    const genQueue = new Queue(cfg.genQueue, { connection, prefix: cfg.bullPrefix });

    await genQueue.add('generate-level', { seed: 'miss', difficulty: 2 }, { jobId: 'gen-miss' });

    await vi.waitFor(async () => {
      const job = await genQueue.getJob('gen-miss');
      expect(job?.failedReason).toContain('missing_openai_key');
    });

    expect(statusUpdates.some((entry) => entry.body && entry.body.status === 'failed')).toBe(true);
    const { testLevel } = await import('../src/tester');
    expect(testLevel).not.toHaveBeenCalled();
  });

  it('reports tester failure details', async () => {
    process.env.OPENAI_API_KEY = 'fake-key';

    vi.doMock('../src/generator', () => ({
      generateLevel: vi.fn(async () => failingLevel),
      closeGenerator: vi.fn(async () => undefined),
    }));

    vi.doMock('../src/tester', () => ({
      testLevel: vi.fn(async () => ({
        ok: false as const,
        reason: 'no_path' as const,
        fail: { ok: false as const, reason: 'no_path' as const },
      })),
    }));

    vi.doMock('../src/scoring', () => ({
      scoreLevel: vi.fn(() => 0),
    }));

    const statusUpdates: Array<{ pathname: string; body: unknown }> = [];

    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const pathname = new URL(url).pathname;

      if (pathname.startsWith('/internal/jobs/') && pathname.endsWith('/status')) {
        statusUpdates.push({ pathname, body: init?.body ? JSON.parse(init.body as string) : null });
        return new Response(null, { status: 204 });
      }
      if (pathname === '/internal/jobs' && method === 'POST') {
        return new Response(null, { status: 204 });
      }
      if (pathname === '/internal/levels' && method === 'POST') {
        return Response.json({ id: failingLevel.id }, { status: 201 });
      }
      if (pathname === `/levels/${failingLevel.id}` && method === 'GET') {
        return Response.json(failingLevel, { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    const { cfg } = await import('../src/config');
    const { startWorkers } = await import('../src/queue');
    await startWorkers();

    const { Queue } = await import('bullmq');
    const Redis = (await import('ioredis-mock')).default;
    const connection = new Redis();
    const genQueue = new Queue(cfg.genQueue, { connection, prefix: cfg.bullPrefix });

    await genQueue.add('generate-level', { seed: 'path', difficulty: 2 }, { jobId: 'gen-path' });

    const testQueue = new Queue(cfg.testQueue, { connection: new Redis(), prefix: cfg.bullPrefix });

    await vi.waitFor(async () => {
      const counts = await testQueue.getJobCounts('failed');
      expect(counts.failed ?? 0).toBeGreaterThanOrEqual(1);
    });

    const failureUpdate = statusUpdates.find(
      (entry) => entry.pathname.includes('/internal/jobs/') && entry.body && entry.body.status === 'failed' && entry.body.error === 'no_path',
    );
    expect(failureUpdate).toBeTruthy();
  });
});
