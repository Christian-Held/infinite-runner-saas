import { randomUUID } from 'node:crypto';

import { Ability } from '@ir/game-spec';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { z } from 'zod';

import { DEFAULT_CONSTRAINTS, closeGenerator, generateLevel } from './generator';
import { fetchLevel, ingestLevel, createJobRecord, updateJobStatus, submitLevelPath } from './internal-client';
import { testLevel } from './tester';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

const AbilityInputSchema = Ability;

export interface GenJobData {
  seed?: string;
  difficulty?: number;
  abilities?: z.input<typeof AbilityInputSchema>;
}

export interface TestJobData {
  levelId: string;
}

export interface WorkerRuntime {
  close(): Promise<void>;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

export async function startWorkers(): Promise<WorkerRuntime> {
  const connection = new IORedis(REDIS_URL);

  const genQueue = new Queue<GenJobData>('gen', {
    connection,
    defaultJobOptions: { removeOnComplete: true },
  });
  const testQueue = new Queue<TestJobData>('test', {
    connection,
    defaultJobOptions: { removeOnComplete: true },
  });

  const genWorker = new Worker<GenJobData>(
    'gen',
    async (job) => {
      const jobId = job.id ?? randomUUID();
      try {
        await updateJobStatus({ id: jobId, status: 'running' });

        const seed = job.data.seed ?? randomUUID();
        const difficulty = job.data.difficulty ?? 1;
        const abilityInput = job.data.abilities ?? { run: true, jump: true };
        const abilities = AbilityInputSchema.parse(abilityInput);

        const level = await generateLevel(seed, difficulty, abilities);

        await ingestLevel({ level, difficulty, seed: level.seed });

        await updateJobStatus({ id: jobId, status: 'succeeded', levelId: level.id });

        const testJobId = randomUUID();
        await createJobRecord({ id: testJobId, type: 'test', status: 'queued', levelId: level.id });
        try {
          await testQueue.add('playtest', { levelId: level.id }, { jobId: testJobId });
        } catch (error) {
          const message = toErrorMessage(error);
          await updateJobStatus({ id: testJobId, status: 'failed', error: message, levelId: level.id });
          throw error;
        }
      } catch (error) {
        const message = toErrorMessage(error);
        await updateJobStatus({ id: jobId, status: 'failed', error: message });
        throw error;
      }
    },
    {
      connection,
      concurrency: 2,
    },
  );

  const testWorker = new Worker<TestJobData>(
    'test',
    async (job) => {
      const jobId = job.id ?? randomUUID();
      try {
        await updateJobStatus({ id: jobId, status: 'running' });

        const level = await fetchLevel(job.data.levelId);
        const result = await testLevel(level);
        if (!result.ok || !result.path) {
          const reason = result.reason ?? 'no_path';
          throw new Error(reason);
        }

        await submitLevelPath({ levelId: job.data.levelId, path: result.path });
        await updateJobStatus({ id: jobId, status: 'succeeded', levelId: job.data.levelId });
        console.log('[testWorker] search done', {
          jobId,
          nodes: result.nodes ?? 0,
          visited: result.visited ?? 0,
          durationMs: result.durationMs ?? 0,
          result: 'ok',
        });
      } catch (error) {
        const message = toErrorMessage(error);
        await updateJobStatus({ id: jobId, status: 'failed', error: message, levelId: job.data.levelId });
        throw error;
      }
    },
    {
      connection,
      concurrency: 4,
    },
  );

  genWorker.on('failed', (job, error) => {
    console.error('[genWorker] failed', { jobId: job?.id, error: error?.message });
  });
  testWorker.on('failed', (job, error) => {
    console.error('[testWorker] failed', { jobId: job?.id, error: error?.message });
  });

  async function close() {
    await Promise.allSettled([genWorker.close(), testWorker.close()]);
    await Promise.allSettled([genQueue.close(), testQueue.close()]);
    try {
      await connection.quit();
    } catch (error) {
      connection.disconnect();
    }
    await closeGenerator();
  }

  return { close };
}
