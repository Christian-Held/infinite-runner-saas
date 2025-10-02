import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

import { Ability } from '@ir/game-spec';
import { z } from 'zod';

import { insertJob, updateJobStatus, upsertSeasonJob } from '../db';
import { recordQueueOperation } from '../metrics';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const BUDGET_ENV = process.env.BUDGET_USD_PER_DAY;
const BUDGET_USD_PER_DAY = BUDGET_ENV ? Number.parseFloat(BUDGET_ENV) : Number.NaN;
const HAS_BUDGET_GUARD = Number.isFinite(BUDGET_USD_PER_DAY) && BUDGET_USD_PER_DAY > 0;

type AbilityInput = z.input<typeof Ability>;

export interface GenJobData {
  seed?: string;
  difficulty?: number;
  abilities?: AbilityInput;
  seasonId?: string;
  levelNumber?: number;
}

export interface QueueManager {
  enqueueGen(input: GenJobData): Promise<string>;
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

export async function createQueueManager(): Promise<QueueManager> {
  const connection = new IORedis(REDIS_URL);

  const genQueue = new Queue<GenJobData>('gen', {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });
  const testQueue = new Queue('test', {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });

  async function readCurrentSpend(): Promise<number> {
    if (!HAS_BUDGET_GUARD) {
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
    if (!HAS_BUDGET_GUARD) {
      return { limitUsd: null, remainingUsd: Number.POSITIVE_INFINITY, ok: true } as const;
    }
    const total = await readCurrentSpend();
    const remaining = Math.max(0, BUDGET_USD_PER_DAY - total);
    return {
      limitUsd: BUDGET_USD_PER_DAY,
      remainingUsd: remaining,
      ok: remaining > 0,
    } as const;
  }

  async function ensureBudgetAvailable(): Promise<boolean> {
    if (!HAS_BUDGET_GUARD) {
      return true;
    }
    const total = await readCurrentSpend();
    return total < BUDGET_USD_PER_DAY;
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

  async function enqueueGen(input: GenJobData): Promise<string> {
    const jobId = uuidv4();
    const startedAt = process.hrtime.bigint();

    if (!(await ensureBudgetAvailable())) {
      recordQueueOperation('gen', 'rejected', startedAt);
      throw new Error('budget_exceeded');
    }

    await insertJob({ id: jobId, type: 'gen', status: 'queued' });
    if (input.seasonId && typeof input.levelNumber === 'number') {
      upsertSeasonJob({
        seasonId: input.seasonId,
        levelNumber: input.levelNumber,
        jobId,
        status: 'queued',
      });
    }
    try {
      await genQueue.add('generate-level', input, { jobId });
      recordQueueOperation('gen', 'enqueued', startedAt);
    } catch (error) {
      const message = resolveErrorMessage(error);
      await updateJobStatus(jobId, 'failed', { error: message });
      recordQueueOperation('gen', 'failed', startedAt);
      throw error;
    }
    return jobId;
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
