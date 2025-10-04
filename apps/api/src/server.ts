import cors from '@fastify/cors';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import type { Logger } from '@pkg/logger';

import { Ability, Level, getLevelPlan } from '@ir/game-spec';

import {
  findBatchById,
  findBatchByKey,
  getJob,
  getLevel,
  getLevelMeta,
  getLevelPath,
  getLevelMetric,
  getSeasonStatus,
  insertBatch,
  insertJob,
  insertLevel,
  insertLevelRevision,
  insertBatchJobs,
  listBatchJobs,
  listBatches,
  listLevelRevisions,
  listLevels,
  listSeasonLevels,
  pingDb,
  setBatchStatus,
  updateLevel,
  upsertLevelMeta,
  upsertLevelMetric,
  upsertLevelPath,
  updateJobStatus,
  upsertSeasonJob,
  updateSeasonJob,
  type BatchJobRecord,
  type BatchRecord,
} from './db';
import type { QueueManager } from './queue';
import { httpRequestDurationSeconds, httpRequestsTotal, registry } from './metrics';
import type { AppConfig } from './config';
import { parseBatchRequest } from './batches';

const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../package.json') as { version?: string };
const apiVersion = typeof packageVersion === 'string' ? packageVersion : '0.0.0';

interface BuildServerOptions {
  db: Database.Database;
  redis: IORedis;
  queueManager: QueueManager;
  logger: Logger;
  config: AppConfig;
  internalToken: string;
}

function createInternalTokenHook(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const routeUrl = request.routeOptions?.url ?? request.routerPath;
    if (!routeUrl || !routeUrl.startsWith('/internal/')) {
      return;
    }
    const token = request.headers['x-internal-token'];
    const provided = Array.isArray(token) ? token[0] : token;
    if (provided !== expectedToken) {
      request.log.warn({ reqId: request.id }, 'Invalid internal token');
      reply.status(401).send({ error: 'unauthorized' });
      return reply;
    }
    return;
  };
}

function extractParams(request: FastifyRequest): Record<string, unknown> {
  const raw = request.params;
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function extractQuery(request: FastifyRequest): Record<string, unknown> {
  const raw = request.query;
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

const GenerateBody = z.object({
  seed: z.string().optional(),
  difficulty: z.number().int().min(1).optional(),
  abilities: Ability.optional(),
});

const IngestBody = z.object({
  level: Level,
  meta: z.object({
    difficulty: z.number().int().min(1),
    seed: z.string(),
  }),
});

const InternalJobBody = z.object({
  id: z.string(),
  type: z.enum(['gen', 'test']),
  status: z.enum(['queued', 'running', 'failed', 'succeeded', 'canceled']).default('queued'),
  levelId: z.string().nullable().optional(),
});

const UpdateJobBody = z.object({
  status: z.enum(['queued', 'running', 'failed', 'succeeded', 'canceled']),
  error: z.string().nullable().optional(),
  levelId: z.string().optional(),
  attempts: z.number().int().min(0).optional(),
  lastReason: z.string().nullable().optional(),
});

const InputCmdSchema = z.object({
  t: z.number().int().min(0),
  left: z.boolean().optional(),
  right: z.boolean().optional(),
  jump: z.boolean().optional(),
  fly: z.boolean().optional(),
  thrust: z.boolean().optional(),
});

const InternalPathBody = z.object({
  level_id: z.string(),
  path: z.array(InputCmdSchema),
});

const LevelPatchBody = z.object({
  level_id: z.string(),
  patch: z.any(),
  reason: z.string(),
  level: Level,
});

const BiomeEnum = z.enum(['meadow', 'cave', 'factory', 'lava', 'sky']);

const LevelMetricsBody = z.object({
  level_id: z.string(),
  score: z.number(),
});

const LevelMetaBody = z.object({
  level_id: z.string(),
  biome: BiomeEnum,
});

const SeasonJobStatusEnum = z.enum(['queued', 'running', 'failed', 'succeeded']);

const SeasonJobStatusBody = z.object({
  season_id: z.string(),
  level_number: z.number().int().min(1),
  status: SeasonJobStatusEnum,
  job_id: z.string().optional(),
  level_id: z.string().optional(),
});

const SeasonBuildBody = z
  .object({
    seasonId: z.string(),
    from: z.number().int().min(1).max(100).default(1),
    to: z.number().int().min(1).max(100).default(100),
  })
  .refine((value) => value.to >= value.from, {
    message: 'invalid_range',
    path: ['to'],
  });

interface BatchMetricsSummary {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  canceled: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
}

function computeBatchMetrics(batch: BatchRecord, jobs: BatchJobRecord[]): BatchMetricsSummary {
  const metrics: BatchMetricsSummary = {
    total: batch.requestedCount,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    avgDurationMs: null,
    p95DurationMs: null,
  };
  const durations: number[] = [];

  for (const job of jobs) {
    switch (job.status) {
      case 'queued':
        metrics.queued += 1;
        break;
      case 'running':
        metrics.running += 1;
        break;
      case 'succeeded':
        metrics.succeeded += 1;
        break;
      case 'failed':
        metrics.failed += 1;
        break;
      case 'canceled':
        metrics.canceled += 1;
        break;
      default:
        break;
    }
    if (typeof job.durationMs === 'number' && Number.isFinite(job.durationMs)) {
      durations.push(job.durationMs);
    }
  }

  if (durations.length > 0) {
    const totalDuration = durations.reduce((sum, value) => sum + value, 0);
    metrics.avgDurationMs = Math.round(totalDuration / durations.length);
    const sorted = [...durations].sort((a, b) => a - b);
    const index = Math.max(0, Math.floor(0.95 * (sorted.length - 1)));
    metrics.p95DurationMs = sorted[index];
  }

  return metrics;
}

function successfulLevels(jobs: BatchJobRecord[]): string[] {
  const levels = new Set<string>();
  for (const job of jobs) {
    if (job.status === 'succeeded' && typeof job.levelId === 'string' && job.levelId.length > 0) {
      levels.add(job.levelId);
    }
  }
  return Array.from(levels);
}

function jobErrors(jobs: BatchJobRecord[]): Array<{ job_id: string; message: string }> {
  const errors: Array<{ job_id: string; message: string }> = [];
  for (const job of jobs) {
    if (job.error) {
      errors.push({ job_id: job.jobId, message: job.error });
    }
  }
  return errors;
}

const ListLevelsQuery = z.object({
  published: z.enum(['true', 'false']).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

const SeasonLevelsQuery = z.object({
  published: z.enum(['true', 'false']).optional(),
});

const ListBatchesQuery = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

export function buildServer({
  db,
  redis,
  queueManager,
  logger,
  config,
  internalToken,
}: BuildServerOptions) {
  const server = Fastify({
    logger: logger.child({ module: 'http' }),
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      if (typeof header === 'string' && header.length > 0) {
        return header;
      }
      return randomUUID();
    },
    bodyLimit: config.batch.requestBodyLimitBytes,
  });

  const enforceInternalToken = createInternalTokenHook(internalToken);
  server.addHook('preHandler', enforceInternalToken);

  const allowedOrigins = config.originAllowList;

  server.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.length === 0) {
        callback(null, false);
        return;
      }
      callback(null, allowedOrigins.includes(origin));
    },
  });

  const rateLogger = logger.child({ module: 'rate-limit' });
  const {
    windowMs: RATE_WINDOW_MS,
    max: RATE_MAX,
    seasonMax: RATE_MAX_SEASON,
    seasonWindowMs: RATE_WINDOW_SEASON_MS,
  } = config.rateLimit;
  const {
    rateLimit: batchRateLimit,
    maxParallelJobs: MAX_PARALLEL_JOBS,
    jobQueueBackpressureMs: JOB_QUEUE_BACKPRESSURE_MS,
    ttlDays: BATCH_TTL_DAYS,
  } = config.batch;

  const ensurePositiveWindow = (windowMs: number) =>
    Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000;

  async function checkRateLimit(
    key: string,
    ip: string,
    max: number,
    windowMs: number,
  ): Promise<boolean> {
    if (!Number.isFinite(max) || max <= 0) {
      return true;
    }
    const safeWindow = ensurePositiveWindow(windowMs);
    const windowId = Math.floor(Date.now() / safeWindow);
    const redisKey = `rate:${key}:${windowId}:${ip}`;
    try {
      const count = await redis.incr(redisKey);
      if (count === 1) {
        await redis.pexpire(redisKey, safeWindow);
      }
      return count <= max;
    } catch (error) {
      rateLogger.warn({ err: error }, 'rate limit check failed');
      return true;
    }
  }

  server.addHook('onRequest', (request, _reply, done) => {
    (request as FastifyRequest & { metricsStart?: bigint }).metricsStart = process.hrtime.bigint();
    request.log.info(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
      },
      'incoming request',
    );
    done();
  });

  server.addHook('onResponse', (request, reply, done) => {
    const metricsStart = (request as FastifyRequest & { metricsStart?: bigint }).metricsStart;
    const route = request.routeOptions?.url ?? request.routerPath ?? request.url;
    const status = String(reply.statusCode);
    httpRequestsTotal.labels(request.method, route, status).inc();
    if (metricsStart) {
      const durationSeconds = Number(process.hrtime.bigint() - metricsStart) / 1_000_000_000;
      httpRequestDurationSeconds.labels(request.method, route, status).observe(durationSeconds);
    }
    const durationMs = metricsStart
      ? Number(process.hrtime.bigint() - metricsStart) / 1_000_000
      : reply.getResponseTime();
    const level: 'info' | 'warn' | 'error' =
      reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info';
    request.log[level](
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs,
      },
      'request completed',
    );
    done();
  });

  server.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Unhandled error');
    if (reply.sent) {
      return;
    }
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    reply.status(statusCode).send({ error: error.message ?? 'internal_error' });
  });

  const getRedisOk = async (): Promise<boolean> => {
    if (redis.status !== 'ready') {
      return false;
    }

    try {
      await redis.ping();
      return true;
    } catch (error) {
      server.log.warn({ err: error }, 'Redis ping failed');
      return false;
    }
  };

  server.get('/health', async () => {
    const redisOk = await getRedisOk();
    const dbOk = pingDb(db);
    const [queues, budget] = await Promise.all([
      queueManager.getQueueOverview(),
      queueManager.getBudgetStatus(),
    ]);

    server.log.debug({ redisOk, dbOk }, 'Health probes completed');

    return {
      status: redisOk && dbOk && budget.ok ? 'ok' : 'degraded',
      db: dbOk,
      redis: redisOk,
      version: apiVersion,
      uptime_s: Math.round(process.uptime()),
      queue: queues,
      budget,
    };
  });

  server.get('/metrics', async (_request, reply) => {
    const metrics = await registry.metrics();
    reply.header('content-type', registry.contentType);
    return metrics;
  });

  server.post('/levels/generate', async (request, reply) => {
    const allowed = await checkRateLimit('levels:generate', request.ip, RATE_MAX, RATE_WINDOW_MS);
    if (!allowed) {
      reply.status(429).send({ error: 'rate_limited' });
      return;
    }
    const body = GenerateBody.parse(request.body ?? {});
    try {
      const jobId = await queueManager.enqueueGen({
        seed: body.seed,
        difficulty: body.difficulty,
        abilities: body.abilities,
      });
      reply.status(202).send({ job_id: jobId });
    } catch (error) {
      if (error instanceof Error && error.message === 'budget_exceeded') {
        reply.status(503).send({ error: 'budget_exceeded' });
        return;
      }
      throw error;
    }
  });

  server.post('/levels/generate-batch', async (request, reply) => {
    const allowed = await checkRateLimit(
      'levels:generate-batch',
      request.ip,
      batchRateLimit.max,
      batchRateLimit.windowMs,
    );
    if (!allowed) {
      reply.status(429).send({ error: 'rate_limited' });
      return;
    }

    let parsed;
    try {
      parsed = parseBatchRequest(request.body ?? {}, config);
    } catch (error) {
      if (error instanceof z.ZodError) {
        reply.status(400).send({ error: 'validation_failed', details: error.flatten() });
        return;
      }
      request.log.error({ err: error }, 'Failed to parse batch request');
      reply.status(400).send({ error: 'invalid_request' });
      return;
    }

    const { normalized, plans } = parsed;

    if (normalized.idempotencyKey) {
      const existing = findBatchByKey(normalized.idempotencyKey);
      if (existing) {
        if (existing.paramsJson !== normalized.fingerprint) {
          reply.status(409).send({ error: 'idempotency_conflict' });
          return;
        }
        const existingJobs = listBatchJobs(existing.id);
        reply.send({
          batch_id: existing.id,
          job_ids: existingJobs.map((job) => job.jobId),
          count: existing.requestedCount,
        });
        return;
      }
    }

    const batchId = randomUUID();
    const jobIds = plans.map(() => randomUUID());
    const createdAt = Date.now();

    const batchJobEntries = plans.map((plan, index) => ({
      batchId,
      jobId: jobIds[index],
      status: 'queued' as const,
      createdAt,
      levelNumber: plan.levelNumber,
      seed: plan.seed,
      difficulty: plan.difficulty,
    }));

    const createBatchRecords = db.transaction(() => {
      insertBatch({
        id: batchId,
        requestedCount: normalized.count,
        paramsJson: normalized.fingerprint,
        idempotencyKey: normalized.idempotencyKey ?? null,
        status: 'queued',
        createdAt,
      });
      plans.forEach((plan, index) => {
        const jobId = jobIds[index];
        insertJob({ id: jobId, type: 'gen', status: 'queued' });
        if (normalized.season) {
          upsertSeasonJob({
            seasonId: normalized.season,
            levelNumber: plan.levelNumber,
            jobId,
            status: 'queued',
          });
        }
      });
      insertBatchJobs(batchJobEntries);
    });

    try {
      createBatchRecords();
    } catch (error) {
      request.log.error({ err: error }, 'Failed to create batch');
      reply.status(500).send({ error: 'batch_creation_failed' });
      return;
    }

    const jobsForQueue = plans.map((plan, index) => ({
      jobId: jobIds[index],
      data: {
        seed: plan.seed,
        difficulty: plan.difficulty,
        abilities: plan.abilities,
        seasonId: normalized.season ?? undefined,
        levelNumber: plan.levelNumber,
      },
    }));

    try {
      await queueManager.enqueuePreparedGenJobs(jobsForQueue, {
        maxParallel: MAX_PARALLEL_JOBS,
        backpressureMs: JOB_QUEUE_BACKPRESSURE_MS,
      });
    } catch (error) {
      request.log.error({ err: error, batchId }, 'Failed to enqueue batch jobs');
      const processed = Array.isArray((error as { processed?: string[] }).processed)
        ? ((error as { processed?: string[] }).processed ?? [])
        : [];
      const failedJobIds = jobIds.filter((jobId) => !processed.includes(jobId));
      for (const jobId of failedJobIds) {
        updateJobStatus(jobId, 'canceled', { error: 'enqueue_failed' });
      }
      setBatchStatus(batchId, 'failed');
      if (error instanceof Error && error.message === 'budget_exceeded') {
        reply.status(503).send({ error: 'budget_exceeded', batch_id: batchId });
        return;
      }
      reply.status(500).send({ error: 'enqueue_failed', batch_id: batchId });
      return;
    }

    request.log.info({ batchId, count: plans.length }, 'Batch enqueued');
    reply.status(202).send({ batch_id: batchId, job_ids: jobIds, count: plans.length });
  });

  server.post('/seasons/build', async (request, reply) => {
    const allowed = await checkRateLimit(
      'seasons:build',
      request.ip,
      RATE_MAX_SEASON,
      RATE_WINDOW_SEASON_MS,
    );
    if (!allowed) {
      reply.status(429).send({ error: 'rate_limited' });
      return;
    }
    const body = SeasonBuildBody.parse(request.body ?? {});
    const from = body.from ?? 1;
    const to = body.to ?? 100;
    let count = 0;
    try {
      for (let levelNumber = from; levelNumber <= to; levelNumber += 1) {
        const plan = getLevelPlan(levelNumber);
        await queueManager.enqueueGen({
          seed: undefined,
          difficulty: plan.difficultyTarget,
          abilities: plan.abilities,
          seasonId: body.seasonId,
          levelNumber,
        });
        count += 1;
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'budget_exceeded') {
        reply.status(503).send({ error: 'budget_exceeded', count });
        return;
      }
      throw error;
    }

    reply.status(202).send({ seasonId: body.seasonId, count });
  });

  server.get('/levels', async (request, reply) => {
    const query = ListLevelsQuery.parse(extractQuery(request));
    const published = typeof query.published === 'string' ? query.published === 'true' : undefined;

    const limitCandidate = query.limit ? Number.parseInt(query.limit, 10) : Number.NaN;
    const offsetCandidate = query.offset ? Number.parseInt(query.offset, 10) : Number.NaN;
    const limit =
      Number.isFinite(limitCandidate) && limitCandidate > 0
        ? Math.min(limitCandidate, 100)
        : undefined;
    const offset =
      Number.isFinite(offsetCandidate) && offsetCandidate >= 0 ? offsetCandidate : undefined;

    const records = listLevels({ published, limit, offset });
    const levels = records.map((entry) => ({
      ...entry.level,
      published: entry.published,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
    }));

    reply.send({ levels });
  });

  server.get('/levels/:id', async (request, reply) => {
    const params = extractParams(request);
    const id = z.string().parse(params.id);
    const level = getLevel(id);
    if (!level) {
      reply.status(404).send({ error: 'not_found' });
      return;
    }
    reply.send(level);
  });

  server.get('/levels/:id/meta', async (request, reply) => {
    const params = extractParams(request);
    const id = z.string().parse(params.id);
    const meta = getLevelMeta(id);
    if (!meta) {
      reply.status(404).send({ error: 'not_found' });
      return;
    }
    reply.send({ biome: meta.biome });
  });

  server.get('/levels/:id/metrics', async (request, reply) => {
    const params = extractParams(request);
    const id = z.string().parse(params.id);
    const metric = getLevelMetric(id);
    if (!metric) {
      reply.status(404).send({ error: 'not_found' });
      return;
    }
    reply.send({ level_id: metric.levelId, score: metric.score, created_at: metric.createdAt });
  });

  server.get('/levels/:id/path', async (request, reply) => {
    const params = extractParams(request);
    const id = z.string().parse(params.id);
    const level = getLevel(id);
    if (!level) {
      reply.status(404).send({ error: 'not_found' });
      return;
    }

    const path = getLevelPath(id);
    if (!path) {
      reply.status(404).send({ error: 'path_not_found' });
      return;
    }
    reply.send({ level_id: id, path });
  });

  server.get('/levels/:id/revisions', async (request, reply) => {
    const params = extractParams(request);
    const id = z.string().parse(params.id);
    const level = getLevel(id);
    if (!level) {
      reply.status(404).send({ error: 'not_found' });
      return;
    }
    const revisions = listLevelRevisions(id);
    reply.send({ level_id: id, revisions });
  });

  server.get('/jobs/:id', async (request, reply) => {
    const params = extractParams(request);
    const id = z.string().parse(params.id);
    const job = getJob(id);
    if (!job) {
      reply.status(404).send({ error: 'not_found' });
      return;
    }
    reply.send(job);
  });

  server.get('/batches/:id', async (request, reply) => {
    const params = extractParams(request);
    const id = z.string().parse(params.id);
    const batch = findBatchById(id);
    if (!batch) {
      reply.status(404).send({ error: 'not_found' });
      return;
    }

    const jobs = listBatchJobs(id);
    const metrics = computeBatchMetrics(batch, jobs);
    const levels = successfulLevels(jobs);
    const errors = jobErrors(jobs);

    reply.send({
      batch_id: batch.id,
      created_at: batch.createdAt,
      updated_at: batch.updatedAt,
      status: batch.status,
      request: batch.params,
      metrics: {
        total: metrics.total,
        queued: metrics.queued,
        running: metrics.running,
        succeeded: metrics.succeeded,
        failed: metrics.failed,
        canceled: metrics.canceled,
        avg_duration_ms: metrics.avgDurationMs,
        p95_duration_ms: metrics.p95DurationMs,
      },
      jobs: jobs.map((job) => ({
        job_id: job.jobId,
        status: job.status,
        level_id: job.levelId,
        error: job.error,
      })),
      levels,
      errors,
    });
  });

  server.get('/batches', async (request, reply) => {
    const query = ListBatchesQuery.parse(extractQuery(request));
    const limitCandidate = query.limit ? Number.parseInt(query.limit, 10) : Number.NaN;
    const limit =
      Number.isFinite(limitCandidate) && limitCandidate > 0 ? Math.min(limitCandidate, 50) : 25;
    const cursorCandidate = query.cursor ? Number.parseInt(query.cursor, 10) : Number.NaN;
    const cursor =
      Number.isFinite(cursorCandidate) && cursorCandidate > 0 ? cursorCandidate : undefined;
    const ttlCutoff =
      typeof BATCH_TTL_DAYS === 'number' && Number.isFinite(BATCH_TTL_DAYS) && BATCH_TTL_DAYS > 0
        ? Date.now() - BATCH_TTL_DAYS * 86_400_000
        : undefined;

    const records = listBatches({ limit, cursor, ttlCutoff });
    const summaries = records.map((batch) => {
      const jobs = listBatchJobs(batch.id);
      const metrics = computeBatchMetrics(batch, jobs);
      return {
        batch_id: batch.id,
        status: batch.status,
        created_at: batch.createdAt,
        updated_at: batch.updatedAt,
        requested_count: batch.requestedCount,
        request: batch.params,
        metrics: {
          total: metrics.total,
          queued: metrics.queued,
          running: metrics.running,
          succeeded: metrics.succeeded,
          failed: metrics.failed,
          canceled: metrics.canceled,
          avg_duration_ms: metrics.avgDurationMs,
          p95_duration_ms: metrics.p95DurationMs,
        },
      };
    });

    const nextCursor =
      summaries.length === limit ? (records[records.length - 1]?.createdAt ?? null) : null;
    reply.send({ batches: summaries, next_cursor: nextCursor });
  });

  server.get('/seasons/:id/status', async (request, reply) => {
    const params = extractParams(request);
    const seasonId = z.string().parse(params.id);
    const status = getSeasonStatus(seasonId);
    reply.send(status);
  });

  server.get('/seasons/:id/levels', async (request, reply) => {
    const params = extractParams(request);
    const seasonId = z.string().parse(params.id);
    const query = SeasonLevelsQuery.parse(extractQuery(request));
    const published = typeof query.published === 'string' ? query.published === 'true' : undefined;
    const levels = listSeasonLevels({ seasonId, published });
    reply.send({ seasonId, levels });
  });

  server.post('/internal/levels', async (request, reply) => {
    const body = IngestBody.parse(request.body ?? {});
    insertLevel(body.level, { difficulty: body.meta.difficulty, seed: body.meta.seed });
    reply.status(201).send({ id: body.level.id });
  });

  server.post('/internal/levels/meta', async (request, reply) => {
    const body = LevelMetaBody.parse(request.body ?? {});
    const level = getLevel(body.level_id);
    if (!level) {
      reply.status(404).send({ error: 'level_not_found' });
      return;
    }

    upsertLevelMeta(body.level_id, body.biome);
    reply.status(204).send();
  });

  server.post('/internal/jobs', async (request, reply) => {
    const body = InternalJobBody.parse(request.body ?? {});
    insertJob({
      id: body.id,
      type: body.type,
      status: body.status,
      level_id: body.levelId ?? null,
    });
    reply.status(204).send();
  });

  server.post('/internal/jobs/:id/status', async (request, reply) => {
    const params = extractParams(request);
    const id = z.string().parse(params.id);
    const body = UpdateJobBody.parse(request.body ?? {});
    updateJobStatus(id, body.status, {
      error: body.error ?? undefined,
      levelId: body.levelId,
      attempts: typeof body.attempts === 'number' ? body.attempts : undefined,
      lastReason: body.lastReason ?? undefined,
    });
    reply.status(204).send();
  });

  server.post('/internal/levels/path', async (request, reply) => {
    const body = InternalPathBody.parse(request.body ?? {});
    const level = getLevel(body.level_id);
    if (!level) {
      reply.status(404).send({ error: 'level_not_found' });
      return;
    }

    upsertLevelPath(body.level_id, body.path);
    reply.status(204).send();
  });

  server.post('/internal/levels/metrics', async (request, reply) => {
    const body = LevelMetricsBody.parse(request.body ?? {});
    const level = getLevel(body.level_id);
    if (!level) {
      reply.status(404).send({ error: 'level_not_found' });
      return;
    }

    upsertLevelMetric(body.level_id, body.score);
    reply.status(204).send();
  });

  server.post('/internal/season-jobs/status', async (request, reply) => {
    const body = SeasonJobStatusBody.parse(request.body ?? {});
    updateSeasonJob({
      seasonId: body.season_id,
      levelNumber: body.level_number,
      status: body.status,
      jobId: body.job_id,
      levelId: body.level_id,
    });
    reply.status(204).send();
  });

  server.post('/internal/levels/patch', async (request, reply) => {
    const body = LevelPatchBody.parse(request.body ?? {});
    const existing = getLevel(body.level_id);
    if (!existing) {
      reply.status(404).send({ error: 'level_not_found' });
      return;
    }

    const parsedLevel = Level.parse(body.level);
    if (parsedLevel.id !== body.level_id) {
      reply.status(400).send({ error: 'id_mismatch' });
      return;
    }

    const revisionId = randomUUID();
    insertLevelRevision({
      id: revisionId,
      levelId: body.level_id,
      patch: body.patch,
      reason: body.reason,
    });
    updateLevel(parsedLevel);
    reply.status(201).send({ id: revisionId });
  });

  server.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ status: 'not-found' });
  });

  return server;
}
