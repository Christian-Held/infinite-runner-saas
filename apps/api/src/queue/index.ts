import { Queue } from 'bullmq';
import type { QueueOptions } from 'bullmq';
import IORedis from 'ioredis';
import { setTimeout as delay } from 'node:timers/promises';
import { v4 as uuidv4 } from 'uuid';

import { Ability } from '@ir/game-spec';
import { resolveQueueConfig } from '@ir/queue-config';
import type { Logger } from '@pkg/logger';
import { z } from 'zod';

import { insertJob, updateJobStatus, upsertSeasonJob } from '../db';
import { recordQueueOperation } from '../metrics';

type AbilityInput = z.input<typeof Ability>;

export interface GenJobData {
  seed?: string;
  difficulty?: number;
  abilities?: AbilityInput;
  seasonId?: string;
  levelNumber?: number;
}

export interface QueueManager {
  enqueueGen(
    input: GenJobData,
    options?: { jobId?: string; skipInsert?: boolean },
  ): Promise<string>;
  enqueuePreparedGenJobs(
    jobs: Array<{ jobId: string; data: GenJobData }>,
    options: { maxParallel: number; backpressureMs: number },
  ): Promise<string[]>;
  isHealthy(): Promise<boolean>;
  getQueueOverview(): Promise<{ gen: QueueCounts; test: QueueCounts }>;
  getBudgetStatus(): Promise<{ limitUsd: number | null; remainingUsd: number; ok: boolean }>;
  close(): Promise<void>;
}

interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatCostKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `cost:day:${year}${month}${day}`;
}

export interface CreateQueueManagerOptions {
  redisUrl: string;
  queuePrefix?: string;
  budgetUsdPerDay: number | null;
  logger?: Logger;
}

export async function createQueueManager({
  redisUrl,
  queuePrefix,
  budgetUsdPerDay,
  logger,
}: CreateQueueManagerOptions): Promise<QueueManager> {
  const queueConfig = resolveQueueConfig({ prefix: queuePrefix });
  const connection = new IORedis(redisUrl);

  const createQueueOptions = (): QueueOptions => ({
    connection,
    prefix: queueConfig.prefix,
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });

  const genQueue = new Queue<GenJobData>(queueConfig.names[0], createQueueOptions());
  const testQueue = new Queue(queueConfig.names[1], createQueueOptions());

  logger?.info(
    { queues: [...queueConfig.names], prefix: queueConfig.prefix },
    'Queue manager configured',
  );

  const budgetLimit =
    typeof budgetUsdPerDay === 'number' && Number.isFinite(budgetUsdPerDay) && budgetUsdPerDay > 0
      ? budgetUsdPerDay
      : null;

  async function readCurrentSpend(): Promise<number> {
    if (budgetLimit === null) {
      return 0;
    }
    const raw = await connection.get(formatCostKey(new Date()));
    if (!raw) {
      return 0;
    }
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async function readBudgetStatus() {
    if (budgetLimit === null) {
      return { limitUsd: null, remainingUsd: Number.POSITIVE_INFINITY, ok: true } as const;
    }
    const total = await readCurrentSpend();
    const remaining = Math.max(0, budgetLimit - total);
    return {
      limitUsd: budgetLimit,
      remainingUsd: remaining,
      ok: remaining > 0,
    } as const;
  }

  async function ensureBudgetAvailable(): Promise<boolean> {
    if (budgetLimit === null) {
      return true;
    }
    const total = await readCurrentSpend();
    return total < budgetLimit;
  }

  async function queueCounts<T>(queue: Queue<T>): Promise<QueueCounts> {
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  }

  async function enqueueGen(
    input: GenJobData,
    options: { jobId?: string; skipInsert?: boolean } = {},
  ): Promise<string> {
    const jobId = options.jobId ?? uuidv4();
    const startedAt = process.hrtime.bigint();

    if (!(await ensureBudgetAvailable())) {
      recordQueueOperation('gen', 'rejected', startedAt);
      if (options.skipInsert) {
        await updateJobStatus(jobId, 'failed', { error: 'budget_exceeded' });
      }
      throw new Error('budget_exceeded');
    }

    if (!options.skipInsert) {
      await insertJob({ id: jobId, type: 'gen', status: 'queued' });
      if (input.seasonId && typeof input.levelNumber === 'number') {
        upsertSeasonJob({
          seasonId: input.seasonId,
          levelNumber: input.levelNumber,
          jobId,
          status: 'queued',
        });
      }
    }

    const payload: GenJobData = { ...input, jobId };
    try {
      await genQueue.add('generate-level', payload, { jobId });
      recordQueueOperation('gen', 'enqueued', startedAt);
    } catch (error) {
      const message = resolveErrorMessage(error);
      await updateJobStatus(jobId, 'failed', { error: message });
      recordQueueOperation('gen', 'failed', startedAt);
      throw error;
    }
    return jobId;
  }

  async function enqueuePreparedGenJobs(
    jobs: Array<{ jobId: string; data: GenJobData }>,
    options: { maxParallel: number; backpressureMs: number },
  ): Promise<string[]> {
    const maxParallel =
      Number.isFinite(options.maxParallel) && options.maxParallel > 0 ? options.maxParallel : 0;
    const backpressureMs =
      Number.isFinite(options.backpressureMs) && options.backpressureMs > 0
        ? options.backpressureMs
        : 50;
    const processed: string[] = [];

    for (const job of jobs) {
      if (maxParallel > 0) {
        // Simple backpressure loop: wait until the queue has spare capacity.
        while (true) {
          const counts = await genQueue.getJobCounts('waiting', 'active');
          const inflight = (counts.waiting ?? 0) + (counts.active ?? 0);
          if (inflight < maxParallel) {
            break;
          }
          await delay(backpressureMs);
        }
      }
      try {
        await enqueueGen(job.data, { jobId: job.jobId, skipInsert: true });
        processed.push(job.jobId);
      } catch (error) {
        const enriched = error instanceof Error ? error : new Error(String(error));
        (enriched as Error & { processed?: string[] }).processed = [...processed];
        throw enriched;
      }
    }
    return processed;
  }

  async function isHealthyRedis(): Promise<boolean> {
    try {
      await connection.ping();
      return true;
    } catch {
      return false;
    }
  }

  async function close() {
    await Promise.allSettled([genQueue.close(), testQueue.close()]);
    try {
      await connection.quit();
    } catch {
      connection.disconnect();
    }
  }

  return {
    enqueueGen,
    enqueuePreparedGenJobs,
    isHealthy: isHealthyRedis,
    getQueueOverview: async () => ({
      gen: await queueCounts(genQueue),
      test: await queueCounts(testQueue),
    }),
    getBudgetStatus: async () => {
      const status = await readBudgetStatus();
      return {
        limitUsd: status.limitUsd,
        remainingUsd: status.remainingUsd,
        ok: status.ok,
      };
    },
    close,
  };
}
