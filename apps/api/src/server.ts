import cors from '@fastify/cors';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import type { Logger } from '@ir/logger';

import { Ability, Level, getLevelPlan } from '@ir/game-spec';

import {
  getJob,
  getLevel,
  getLevelMeta,
  getLevelPath,
  getLevelMetric,
  getSeasonStatus,
  insertJob,
  insertLevel,
  insertLevelRevision,
  listLevelRevisions,
  listSeasonLevels,
  pingDb,
  updateLevel,
  upsertLevelMeta,
  upsertLevelMetric,
  upsertLevelPath,
  updateJobStatus,
  updateSeasonJob,
} from './db';
import type { QueueManager } from './queue';
import { httpRequestDurationSeconds, httpRequestsTotal, registry } from './metrics';
import type { AppConfig } from './config';

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
  return (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.headers['x-internal-token'];
    const provided = Array.isArray(token) ? token[0] : token;
    if (provided !== expectedToken) {
      request.log.warn({ reqId: request.id }, 'Invalid internal token');
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }
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
  status: z.enum(['queued', 'running', 'failed', 'succeeded']).default('queued'),
  levelId: z.string().nullable().optional(),
});

const UpdateJobBody = z.object({
  status: z.enum(['queued', 'running', 'failed', 'succeeded']),
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

const SeasonLevelsQuery = z.object({
  published: z.enum(['true', 'false']).optional(),
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
  });

  const requireInternalToken = createInternalTokenHook(internalToken);

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

  const ensurePositiveWindow = (windowMs: number) => (Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000);

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
    request.log.info(
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

  server.post('/internal/levels', { preHandler: requireInternalToken }, async (request, reply) => {
    const body = IngestBody.parse(request.body ?? {});
    insertLevel(body.level, { difficulty: body.meta.difficulty, seed: body.meta.seed });
    reply.status(201).send({ id: body.level.id });
  });

  server.post('/internal/levels/meta', { preHandler: requireInternalToken }, async (request, reply) => {
    const body = LevelMetaBody.parse(request.body ?? {});
    const level = getLevel(body.level_id);
    if (!level) {
      reply.status(404).send({ error: 'level_not_found' });
      return;
    }

    upsertLevelMeta(body.level_id, body.biome);
    reply.status(204).send();
  });

  server.post('/internal/jobs', { preHandler: requireInternalToken }, async (request, reply) => {
    const body = InternalJobBody.parse(request.body ?? {});
    insertJob({
      id: body.id,
      type: body.type,
      status: body.status,
      level_id: body.levelId ?? null,
    });
    reply.status(204).send();
  });

  server.post('/internal/jobs/:id/status', { preHandler: requireInternalToken }, async (request, reply) => {
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

  server.post('/internal/levels/path', { preHandler: requireInternalToken }, async (request, reply) => {
    const body = InternalPathBody.parse(request.body ?? {});
    const level = getLevel(body.level_id);
    if (!level) {
      reply.status(404).send({ error: 'level_not_found' });
      return;
    }

    upsertLevelPath(body.level_id, body.path);
    reply.status(204).send();
  });

  server.post('/internal/levels/metrics', { preHandler: requireInternalToken }, async (request, reply) => {
    const body = LevelMetricsBody.parse(request.body ?? {});
    const level = getLevel(body.level_id);
    if (!level) {
      reply.status(404).send({ error: 'level_not_found' });
      return;
    }

    upsertLevelMetric(body.level_id, body.score);
    reply.status(204).send();
  });

  server.post('/internal/season-jobs/status', { preHandler: requireInternalToken }, async (request, reply) => {
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

  server.post('/internal/levels/patch', { preHandler: requireInternalToken }, async (request, reply) => {
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
