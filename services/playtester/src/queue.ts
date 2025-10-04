import { randomUUID } from 'node:crypto';

import { Ability, Level, type LevelT } from '@ir/game-spec';
import { Queue, QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { z } from 'zod';

import { cfg } from './config';
import { trackAndCheck } from './costguard';
import { fetchJson } from './http';
import { closeGenerator, generateLevel } from './generator';
import { scoreLevel } from './scoring';
import { testLevel } from './tester';

import { logger } from './logger';

interface GenJobData {
  jobId?: string;
  seed?: string;
  difficulty?: number;
  abilities?: z.input<typeof Ability>;
}

interface TestJobData {
  levelId: string;
  jobId: string;
}

interface WorkerState {
  connection: IORedis;
  genQueue: Queue<GenJobData>;
  testQueue: Queue<TestJobData>;
  genWorker: Worker<GenJobData, unknown, string>;
  testWorker: Worker<TestJobData, unknown, string>;
  genEvents: QueueEvents;
  testEvents: QueueEvents;
}

const queueEventLogger = logger.child({ module: 'queue-events' });

let state: WorkerState | null = null;

function durationMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

async function ensureBudgetAvailable(): Promise<void> {
  if (!Number.isFinite(cfg.budgetUsdPerDay) || cfg.budgetUsdPerDay <= 0) {
    return;
  }
  const status = await trackAndCheck({ inputTokens: 0, outputTokens: 0 });
  if (!status.ok) {
    const error = new Error('budget_exceeded');
    (error as Error & { code?: string }).code = 'budget_exceeded';
    throw error;
  }
}

async function safeUpdateJobStatus(
  jobId: string,
  body: { status: 'queued' | 'running' | 'failed' | 'succeeded'; levelId?: string; error?: string | null },
): Promise<void> {
  try {
    await fetchJson({
      method: 'POST',
      path: `/internal/jobs/${jobId}/status`,
      body: {
        status: body.status,
        levelId: body.levelId,
        error: body.error ?? null,
      },
      logger,
    });
  } catch (error) {
    logger.error({ err: error, jobId }, 'Failed to update job status');
  }
}

async function safeCreateTestJobRecord(params: { jobId: string; levelId: string }): Promise<void> {
  try {
    await fetchJson({
      method: 'POST',
      path: '/internal/jobs',
      body: {
        id: params.jobId,
        type: 'test',
        status: 'queued',
        levelId: params.levelId,
      },
      logger,
    });
  } catch (error) {
    logger.error({ err: error, jobId: params.jobId }, 'Failed to create test job record');
  }
}

export async function startWorkers(): Promise<void> {
  if (state) {
    return;
  }

  if (!cfg.openaiKey) {
    const error = new Error('OPENAI_API_KEY is not set');
    logger.error({ err: error }, 'Cannot start playtester without OPENAI_API_KEY');
    throw error;
  }

  logger.info(
    {
      redisUrl: cfg.redisUrl,
      prefix: cfg.bullPrefix,
      genQueue: cfg.genQueue,
      testQueue: cfg.testQueue,
      genConcurrency: 2,
      testConcurrency: 4,
    },
    'Starting playtester workers',
  );

  const connection = new IORedis(cfg.redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
  });
  connection.on('error', (error) => {
    logger.error({ err: error }, 'Redis connection error');
  });
  connection.on('ready', () => {
    logger.info({ redisUrl: cfg.redisUrl }, 'Redis connection ready');
  });
  connection.on('end', () => {
    logger.warn('Redis connection ended');
  });
  connection.on('reconnecting', (delay) => {
    logger.warn({ delay }, 'Redis reconnecting');
  });

  const sharedQueueOptions = { connection, prefix: cfg.bullPrefix };

  const genQueue = new Queue<GenJobData>(cfg.genQueue, sharedQueueOptions);
  const testQueue = new Queue<TestJobData>(cfg.testQueue, sharedQueueOptions);
  const genEvents = new QueueEvents(cfg.genQueue, sharedQueueOptions);
  const testEvents = new QueueEvents(cfg.testQueue, sharedQueueOptions);

  const attachQueueEvents = (events: QueueEvents, queueName: 'gen' | 'test') => {
    const eventLogger = queueEventLogger.child({ queue: queueName });
    events.on('waiting', ({ jobId }) => {
      eventLogger.info({ jobId }, 'Job enqueued');
    });
    events.on('active', ({ jobId, prev }) => {
      eventLogger.info({ jobId, previous: prev }, 'Job active');
    });
    events.on('stalled', ({ jobId }) => {
      eventLogger.warn({ jobId }, 'Job stalled');
    });
    events.on('completed', ({ jobId, returnvalue }) => {
      eventLogger.info({ jobId, result: returnvalue }, 'Job completed');
    });
    events.on('failed', ({ jobId, failedReason }) => {
      eventLogger.error({ jobId, reason: failedReason }, 'Job failed');
    });
  };

  attachQueueEvents(genEvents, 'gen');
  attachQueueEvents(testEvents, 'test');

  const genWorker = new Worker<GenJobData>(
    cfg.genQueue,
    async (job) => {
      const started = process.hrtime.bigint();
      const jobId = typeof job.data?.jobId === 'string' ? job.data.jobId : job.id;
      const jobLogger = logger.child({ queue: 'gen', jobId });
      let levelId: string | null = null;

      jobLogger.info(
        {
          jobId,
          attempt: job.attemptsMade + 1,
          data: job.data,
        },
        'GEN job started',
      );
      try {
        await safeUpdateJobStatus(jobId, { status: 'running' });
        await ensureBudgetAvailable();

        const seed = job.data?.seed ?? job.id;
        const difficulty = typeof job.data?.difficulty === 'number' ? job.data.difficulty : 1;
        const abilities = job.data?.abilities;

        const level = await generateLevel(seed, difficulty, abilities, jobLogger);

        const ingest = await fetchJson<{ id: string }>({
          method: 'POST',
          path: '/internal/levels',
          body: {
            level,
            meta: { difficulty, seed: level.seed ?? seed },
          },
          logger: jobLogger,
        });

        levelId = ingest.id;
        const testJobId = randomUUID();

        await safeCreateTestJobRecord({ jobId: testJobId, levelId });
        try {
          await testQueue.add(
            'test-level',
            { levelId, jobId: testJobId },
            { jobId: testJobId },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          jobLogger.error({ err: error, testJobId, levelId }, 'Failed to enqueue TEST job');
          await safeUpdateJobStatus(testJobId, {
            status: 'failed',
            levelId,
            error: message,
          });
          throw error;
        }
        await safeUpdateJobStatus(jobId, { status: 'succeeded', levelId });

        const duration = durationMs(started);
        jobLogger.info({ jobId, levelId, durationMs: duration }, 'GEN job completed');

        return { levelId, jobId, testJobId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        jobLogger.error(
          { err: error, jobId, levelId, durationMs: durationMs(started) },
          'GEN job failed',
        );
        await safeUpdateJobStatus(jobId, { status: 'failed', error: message });
        throw error;
      }
    },
    { connection, concurrency: 2, prefix: cfg.bullPrefix },
  );

  const testWorker = new Worker<TestJobData>(
    cfg.testQueue,
    async (job) => {
      const started = process.hrtime.bigint();
      const jobLogger = logger.child({ queue: 'test', jobId: job.data.jobId });
      jobLogger.info(
        {
          jobId: job.data.jobId,
          attempt: job.attemptsMade + 1,
          levelId: job.data.levelId,
        },
        'TEST job started',
      );
      try {
        await safeUpdateJobStatus(job.data.jobId, {
          status: 'running',
          levelId: job.data.levelId,
        });

        const level = Level.parse(
          await fetchJson<LevelT>({
            path: `/levels/${job.data.levelId}`,
            logger: jobLogger,
            internal: false,
          }),
        );

        const result = await testLevel(level, jobLogger);
        if (result.ok && result.path) {
          await fetchJson({
            method: 'POST',
            path: '/internal/levels/path',
            body: { level_id: job.data.levelId, path: result.path },
            logger: jobLogger,
          });
          const score = scoreLevel(level);
          await fetchJson({
            method: 'POST',
            path: '/internal/levels/metrics',
            body: { level_id: job.data.levelId, score },
            logger: jobLogger,
          });
          await safeUpdateJobStatus(job.data.jobId, {
            status: 'succeeded',
            levelId: job.data.levelId,
          });
          const duration = durationMs(started);
          jobLogger.info(
            { jobId: job.data.jobId, levelId: job.data.levelId, durationMs: duration },
            'TEST job completed',
          );
          return { ok: true, levelId: job.data.levelId };
        }

        const reason = result.reason ?? 'test_failed';
        await safeUpdateJobStatus(job.data.jobId, {
          status: 'failed',
          levelId: job.data.levelId,
          error: reason,
        });
        const error = new Error(reason);
        (error as Error & { details?: unknown }).details = result.fail?.details ?? result.details;
        throw error;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await safeUpdateJobStatus(job.data.jobId, {
          status: 'failed',
          levelId: job.data.levelId,
          error: message,
        });
        jobLogger.error(
          {
            err: error,
            jobId: job.data.jobId,
            levelId: job.data.levelId,
            durationMs: durationMs(started),
          },
          'TEST job failed',
        );
        throw error;
      }
    },
    { connection, concurrency: 4, prefix: cfg.bullPrefix },
  );

  genWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'GEN worker failure event');
  });
  testWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'TEST worker failure event');
  });

  state = {
    connection,
    genQueue,
    testQueue,
    genWorker,
    testWorker,
    genEvents,
    testEvents,
  };
}

export async function stopWorkers(): Promise<void> {
  if (!state) {
    return;
  }

  const current = state;
  state = null;

  logger.info('Stopping playtester workers');
  await Promise.allSettled([current.genWorker.close(), current.testWorker.close()]);
  await Promise.allSettled([
    current.genQueue.close(),
    current.testQueue.close(),
    current.genEvents.close(),
    current.testEvents.close(),
  ]);
  try {
    await current.connection.quit();
  } catch (error) {
    logger.warn({ err: error }, 'Failed to quit Redis connection, forcing disconnect');
    current.connection.disconnect();
  }
  await closeGenerator();
  logger.info('Playtester workers stopped');
}
