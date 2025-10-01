import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { setTimeout as delay } from 'node:timers/promises';
import { v4 as uuidv4 } from 'uuid';

import { Ability, Level } from '@ir/game-spec';
import { z } from 'zod';

import { demoLevel } from '../demo';
import { insertJob, insertLevel, updateJobStatus } from '../db';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

type AbilityInput = z.input<typeof Ability>;

export interface GenJobData {
  seed?: string;
  difficulty?: number;
  abilities?: AbilityInput;
}

export interface TestJobData {
  levelId: string;
}

export interface QueueManager {
  enqueueGen(input: GenJobData): Promise<string>;
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function createQueueManager(): Promise<QueueManager> {
  const connection = new IORedis(REDIS_URL);

  const genQueue = new Queue<GenJobData>('gen', {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });
  const testQueue = new Queue<TestJobData>('test', {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });

  const genWorker = new Worker<GenJobData>(
    'gen',
    async (job) => {
      try {
        const jobId = job.id;
        if (!jobId) {
          throw new Error('Missing job id for generation job');
        }
        await updateJobStatus(jobId, 'running');

        const seed = job.data?.seed ?? uuidv4();
        const difficulty = job.data?.difficulty ?? 1;
        const abilitiesInput = job.data?.abilities ?? { run: true, jump: true };
        const abilities = Ability.parse(abilitiesInput);

        const baseLevel = demoLevel(difficulty, seed, abilities);
        const levelId = uuidv4();
        const level = Level.parse({
          ...baseLevel,
          id: levelId,
          seed,
          rules: {
            ...baseLevel.rules,
            difficulty,
            abilities,
          },
        });

        insertLevel(level, { difficulty: level.rules.difficulty, seed: level.seed });

        const testJobId = uuidv4();
        await insertJob({ id: testJobId, type: 'test', status: 'queued', level_id: levelId });
        try {
          await testQueue.add('test-level', { levelId }, { jobId: testJobId });
        } catch (error) {
          const message = resolveErrorMessage(error);
          await updateJobStatus(testJobId, 'failed', { error: message });
          throw error;
        }

        await updateJobStatus(jobId, 'succeeded', { levelId });
        return { levelId, testJobId };
      } catch (error) {
        const message = resolveErrorMessage(error);
        const jobId = job.id;
        if (jobId) {
          await updateJobStatus(jobId, 'failed', { error: message });
        }
        throw error;
      }
    },
    { connection },
  );

  const testWorker = new Worker<TestJobData>(
    'test',
    async (job) => {
      try {
        const jobId = job.id;
        if (!jobId) {
          throw new Error('Missing job id for test job');
        }
        await updateJobStatus(jobId, 'running');
        await delay(500);
        await updateJobStatus(jobId, 'succeeded');
        return { levelId: job.data.levelId };
      } catch (error) {
        const message = resolveErrorMessage(error);
        const jobId = job.id;
        if (jobId) {
          await updateJobStatus(jobId, 'failed', { error: message });
        }
        throw error;
      }
    },
    { connection },
  );

  async function enqueueGen(input: GenJobData): Promise<string> {
    const jobId = uuidv4();
    await insertJob({ id: jobId, type: 'gen', status: 'queued' });
    try {
      await genQueue.add('generate-level', input, { jobId });
    } catch (error) {
      const message = resolveErrorMessage(error);
      await updateJobStatus(jobId, 'failed', { error: message });
      throw error;
    }
    return jobId;
  }

  async function isHealthyRedis(): Promise<boolean> {
    try {
      await connection.ping();
      return true;
    } catch (error) {
      return false;
    }
  }

  async function close() {
    await Promise.allSettled([genWorker.close(), testWorker.close()]);
    await Promise.allSettled([genQueue.close(), testQueue.close()]);
    try {
      await connection.quit();
    } catch (error) {
      connection.disconnect();
    }
  }

  return {
    enqueueGen,
    isHealthy: isHealthyRedis,
    close,
  };
}
