import { describe, expect, it, beforeEach, vi } from 'vitest';

import { resolveQueueConfig } from '@ir/queue-config';

import type { Logger } from '@ir/logger';

process.env.BUDGET_USD_PER_DAY = process.env.BUDGET_USD_PER_DAY ?? '5';
process.env.INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal';

let createdQueues: { name: string; opts: { prefix?: string } }[] = [];
let createdWorkers: { name: string; opts: { connection?: unknown } }[] = [];

vi.mock('bullmq', () => {
  class QueueMock<T> {
    name: string;
    opts: { prefix?: string };
    constructor(name: string, opts: { prefix?: string }) {
      this.name = name;
      this.opts = opts;
      createdQueues.push({ name, opts });
    }
    close = vi.fn().mockResolvedValue(undefined);
    getJobCounts = vi.fn().mockResolvedValue({});
  }

  class WorkerMock<T> {
    name: string;
    constructor(name: string, _processor: unknown, opts: { connection?: unknown }) {
      this.name = name;
      createdWorkers.push({ name, opts });
    }
    close = vi.fn().mockResolvedValue(undefined);
    on = vi.fn().mockReturnThis();
  }

  return { Queue: QueueMock, Worker: WorkerMock };
});

vi.mock('ioredis', () => {
  return {
    default: class {
      on = vi.fn();
      quit = vi.fn().mockResolvedValue(undefined);
      disconnect = vi.fn();
      ping = vi.fn().mockResolvedValue('PONG');
      get = vi.fn().mockResolvedValue(null);
      set = vi.fn().mockResolvedValue(null);
    },
  };
});

const { startWorkers } = await import('./queue');

describe('worker configuration', () => {
  beforeEach(() => {
    createdQueues = [];
    createdWorkers = [];
    vi.clearAllMocks();
  });

  it('creates workers using shared queue names and prefix', async () => {
    const baseLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      fatal: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(() => baseLogger),
    };
    const logger = baseLogger as unknown as Logger;

    const runtime = await startWorkers(logger);
    const config = resolveQueueConfig({ prefix: process.env.QUEUE_PREFIX });

    expect(createdQueues.map((entry) => entry.name)).toEqual(['gen', 'test']);
    createdQueues.forEach((entry) => {
      expect(entry.opts.prefix).toBe(config.prefix);
    });
    expect(createdWorkers.map((entry) => entry.name)).toEqual(['gen', 'test']);
    expect(logger.info).toHaveBeenCalledWith(
      { queues: ['gen', 'test'], prefix: config.prefix },
      'Starting playtester workers',
    );

    await runtime.close();
  });
});
