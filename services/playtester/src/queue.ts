import { randomUUID } from 'node:crypto';

import { Ability, getBiome } from '@ir/game-spec';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { z } from 'zod';

import type { Logger } from '@ir/logger';

import { closeGenerator, generateLevel } from './generator';
import {
  fetchLevel,
  ingestLevel,
  submitLevelMeta,
  createJobRecord,
  updateJobStatus,
  submitLevelPath,
  submitLevelPatch,
  submitLevelMetrics,
  updateSeasonJobStatus,
} from './internal-client';
import { testLevel } from './tester';
import { tune } from './tuner';
import { scoreLevel } from './scoring';
import { recordQueueJob } from './metrics';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const MAX_TUNE_ROUNDS = Number.parseInt(process.env.TUNE_MAX_ROUNDS ?? '3', 10);

const AbilityInputSchema = Ability;

export interface GenJobData {
  seed?: string;
  difficulty?: number;
  abilities?: z.input<typeof AbilityInputSchema>;
  seasonId?: string;
  levelNumber?: number;
}

export interface TestJobData {
  levelId: string;
  seasonId?: string;
  levelNumber?: number;
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

export async function startWorkers(logger: Logger): Promise<WorkerRuntime> {
  const connection = new IORedis(REDIS_URL);
  const queueLogger = logger.child({ module: 'workers', redisUrl: REDIS_URL });

  connection.on('error', (error) => {
    queueLogger.error({ err: error }, 'Redis connection error');
  });

  const genQueue = new Queue<GenJobData>('gen', {
    connection,
    defaultJobOptions: { removeOnComplete: true },
  });
  const testQueue = new Queue<TestJobData>('test', {
    connection,
    defaultJobOptions: { removeOnComplete: true },
  });

  queueLogger.info(
    {
      queues: ['gen', 'test'],
      prefix: genQueue.opts.prefix ?? 'bull',
    },
    'Starting playtester workers',
  );

  const genWorkerLogger = queueLogger.child({ worker: 'gen' });
  const testWorkerLogger = queueLogger.child({ worker: 'test' });

  const genWorker = new Worker<GenJobData>(
    'gen',
    async (job) => {
      const jobId = job.id ?? randomUUID();
      const jobLogger = genWorkerLogger.child({ jobId });
      const startedAt = process.hrtime.bigint();
      jobLogger.info({ data: job.data }, 'Generation job started');
      try {
        await updateJobStatus({ id: jobId, status: 'running' });

        const seed = job.data.seed ?? randomUUID();
        const difficulty = job.data.difficulty ?? 1;
        const abilityInput = job.data.abilities ?? { run: true, jump: true };
        const abilities = AbilityInputSchema.parse(abilityInput);

        if (job.data.seasonId && typeof job.data.levelNumber === 'number') {
          await updateSeasonJobStatus({
            seasonId: job.data.seasonId,
            levelNumber: job.data.levelNumber,
            status: 'running',
            jobId,
          });
        }

        const level = await generateLevel(
          seed,
          difficulty,
          abilities,
          jobLogger,
          job.data.levelNumber,
          job.data.seasonId,
        );

        await ingestLevel({ level, difficulty, seed: level.seed });
        const levelNumberForMeta = job.data.levelNumber ?? 1;
        const { biome: biomeName } = getBiome(levelNumberForMeta);
        await submitLevelMeta({ levelId: level.id, biome: biomeName });

        await updateJobStatus({ id: jobId, status: 'succeeded', levelId: level.id });

        if (job.data.seasonId && typeof job.data.levelNumber === 'number') {
          await updateSeasonJobStatus({
            seasonId: job.data.seasonId,
            levelNumber: job.data.levelNumber,
            status: 'running',
            jobId,
            levelId: level.id,
          });
        }

        const testJobId = randomUUID();
        await createJobRecord({ id: testJobId, type: 'test', status: 'queued', levelId: level.id });
        try {
          await testQueue.add(
            'playtest',
            { levelId: level.id, seasonId: job.data.seasonId, levelNumber: job.data.levelNumber },
            { jobId: testJobId },
          );
        } catch (error) {
          const message = toErrorMessage(error);
          await updateJobStatus({
            id: testJobId,
            status: 'failed',
            error: message,
            levelId: level.id,
          });
          jobLogger.error({ err: error }, 'Failed to enqueue test job');
          throw error;
        }

        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        jobLogger.info({ durationMs, levelId: level.id }, 'Generation job succeeded');
        recordQueueJob('gen', 'succeeded', startedAt);
      } catch (error) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        jobLogger.error({ err: error, durationMs }, 'Generation job failed');
        const message = toErrorMessage(error);
        await updateJobStatus({ id: jobId, status: 'failed', error: message });
        if (job.data.seasonId && typeof job.data.levelNumber === 'number') {
          await updateSeasonJobStatus({
            seasonId: job.data.seasonId,
            levelNumber: job.data.levelNumber,
            status: 'failed',
            jobId,
          });
        }
        recordQueueJob('gen', 'failed', startedAt);
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
      const jobLogger = testWorkerLogger.child({ jobId });
      const startedAt = process.hrtime.bigint();
      jobLogger.info({ data: job.data }, 'Test job started');
      let failedAttempts = 0;
      let lastReason: string | undefined;
      try {
        await updateJobStatus({
          id: jobId,
          status: 'running',
          levelId: job.data.levelId,
          attempts: 0,
        });

        let level = await fetchLevel(job.data.levelId);
        const maxRounds =
          Number.isFinite(MAX_TUNE_ROUNDS) && MAX_TUNE_ROUNDS > 0 ? MAX_TUNE_ROUNDS : 3;

        for (let round = 0; round < maxRounds; round += 1) {
          const result = await testLevel(level, jobLogger);
          if (result.ok && result.path) {
            await submitLevelPath({ levelId: job.data.levelId, path: result.path });
            const finalScore = scoreLevel(level);
            await submitLevelMetrics({ levelId: job.data.levelId, score: finalScore });
            await updateJobStatus({
              id: jobId,
              status: 'succeeded',
              levelId: job.data.levelId,
              attempts: failedAttempts,
            });
            if (job.data.seasonId && typeof job.data.levelNumber === 'number') {
              await updateSeasonJobStatus({
                seasonId: job.data.seasonId,
                levelNumber: job.data.levelNumber,
                status: 'succeeded',
                levelId: job.data.levelId,
                jobId,
              });
            }
            jobLogger.info({
              attempt: round + 1,
              nodes: result.nodes ?? 0,
              durationMs: result.durationMs ?? 0,
            }, 'Test run succeeded');
            const totalDurationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            jobLogger.info({ durationMs: totalDurationMs, attempts: failedAttempts }, 'Test job succeeded');
            recordQueueJob('test', 'succeeded', startedAt);
            return;
          }

          const fail = result.fail ?? {
            ok: false as const,
            reason: result.reason ?? 'no_path',
          };

          failedAttempts += 1;
          lastReason = fail.reason;

          await updateJobStatus({
            id: jobId,
            status: 'running',
            levelId: job.data.levelId,
            attempts: failedAttempts,
            lastReason,
          });

          jobLogger.warn({
            attempt: round + 1,
            nodes: result.nodes ?? 0,
            durationMs: result.durationMs ?? 0,
            reason: fail.reason,
          }, 'Test run failed, attempting tune');

          const tuned = tune(level, fail, jobLogger);

          if (!tuned) {
            throw new Error(fail.reason);
          }

          await submitLevelPatch({
            levelId: job.data.levelId,
            patch: tuned.patch,
            reason: fail.reason,
            level: tuned.patched,
          });

          level = tuned.patched;
        }

        throw new Error(lastReason ?? 'no_path');
      } catch (error) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        jobLogger.error({ err: error, durationMs, failedAttempts, lastReason }, 'Test job failed');
        const message = toErrorMessage(error);
        await updateJobStatus({
          id: jobId,
          status: 'failed',
          error: message,
          levelId: job.data.levelId,
          attempts: failedAttempts,
          lastReason,
        });
        if (job.data.seasonId && typeof job.data.levelNumber === 'number') {
          await updateSeasonJobStatus({
            seasonId: job.data.seasonId,
            levelNumber: job.data.levelNumber,
            status: 'failed',
            levelId: job.data.levelId,
            jobId,
          });
        }
        recordQueueJob('test', 'failed', startedAt);
        throw error;
      }
    },
    {
      connection,
      concurrency: 4,
    },
  );

  genWorker.on('failed', (job, error) => {
    genWorkerLogger.error({ jobId: job?.id, err: error }, 'Generation worker failure event');
  });
  testWorker.on('failed', (job, error) => {
    testWorkerLogger.error({ jobId: job?.id, err: error }, 'Test worker failure event');
  });

  async function close() {
    queueLogger.info('Closing playtester workers');
    await Promise.allSettled([genWorker.close(), testWorker.close()]);
    await Promise.allSettled([genQueue.close(), testQueue.close()]);
    try {
      await connection.quit();
    } catch (error) {
      queueLogger.warn({ err: error }, 'Failed to quit Redis connection, forcing disconnect');
      connection.disconnect();
    }
    await closeGenerator();
    queueLogger.info('Playtester workers closed');
  }

  return { close };
}
