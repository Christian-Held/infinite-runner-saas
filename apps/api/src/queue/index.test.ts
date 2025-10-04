import { describe, expect, it, beforeEach, vi } from 'vitest';

import { resolveQueueConfig } from '@ir/queue-config';

import type { Logger } from '@ir/logger';

let createdQueues: { name: string; opts: { prefix?: string } }[] = [];

vi.mock('bullmq', () => {
  class QueueMock {
    name: string;
    opts: { prefix?: string };
    constructor(name: string, opts: { prefix?: string }) {
      this.name = name;
      this.opts = opts;
      createdQueues.push({ name, opts });
    }
    getJobCounts = vi.fn().mockResolvedValue({});
    close = vi.fn().mockResolvedValue(undefined);
  }
  return { Queue: QueueMock };
});

vi.mock('ioredis', () => {
  return {
    default: class {
      get = vi.fn().mockResolvedValue(null);
      quit = vi.fn().mockResolvedValue(undefined);
      disconnect = vi.fn();
      ping = vi.fn().mockResolvedValue('PONG');
      on = vi.fn();
    },
  };
});

const { createQueueManager } = await import('./index');

describe('queue manager configuration', () => {
  beforeEach(() => {
    createdQueues = [];
    vi.clearAllMocks();
  });

  it('uses shared queue names and prefix for producers', async () => {
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

    const queuePrefix = 'diagnostics';
    const manager = await createQueueManager({
      redisUrl: 'redis://localhost:6379',
      queuePrefix,
      budgetUsdPerDay: null,
      logger,
    });

    expect(createdQueues).toHaveLength(2);
    const names = createdQueues.map((entry) => entry.name);
    expect(names).toEqual(['gen', 'test']);
    const config = resolveQueueConfig({ prefix: queuePrefix });
    createdQueues.forEach((entry) => {
      expect(entry.opts.prefix).toBe(config.prefix);
    });
    expect(logger.info).toHaveBeenCalledWith(
      { queues: ['gen', 'test'], prefix: config.prefix },
      'Queue manager configured',
    );

    await manager.close();
  });
});
