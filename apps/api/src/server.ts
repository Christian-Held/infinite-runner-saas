import cors from '@fastify/cors';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import pino from 'pino';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { Ability, Level, getLevelPlan } from '@ir/game-spec';

import {
  getJob,
  getLevel,
  getLevelPath,
  insertJob,
  insertLevel,
  insertLevelRevision,
  listLevelRevisions,
  listSeasonLevels,
  pingDb,
  updateLevel,
  upsertLevelPath,
  updateJobStatus,
  updateSeasonJob,
  upsertLevelMetric,
  getLevelMetric,
  getSeasonStatus,
} from './db';
import type { QueueManager } from './queue';

interface BuildServerOptions {
  db: Database.Database;
  redis: IORedis;
  queueManager: QueueManager;
}

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal';

function requireInternalToken(request: FastifyRequest): void {
  const token = request.headers['x-internal-token'];
  if ((Array.isArray(token) ? token[0] : token) !== INTERNAL_TOKEN) {
    throw new Error('unauthorized');
  }
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

const LevelMetricsBody = z.object({
  level_id: z.string(),
  score: z.number(),
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

export function buildServer({ db, redis, queueManager }: BuildServerOptions) {
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const server = Fastify({ logger });

  server.register(cors, {
    origin: 'http://localhost:5173',
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

    return {
      status: 'ok',
      db: pingDb(db),
      redis: redisOk,
    };
  });

  server.post('/levels/generate', async (request, reply) => {
    const body = GenerateBody.parse(request.body ?? {});
    const jobId = await queueManager.enqueueGen({
      seed: body.seed,
      difficulty: body.difficulty,
      abilities: body.abilities,
    });
    reply.status(202).send({ job_id: jobId });
  });

  server.post('/seasons/build', async (request, reply) => {
    const body = SeasonBuildBody.parse(request.body ?? {});
    const from = body.from ?? 1;
    const to = body.to ?? 100;
    let count = 0;

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

  server.post('/internal/levels', async (request, reply) => {
    try {
      requireInternalToken(request);
    } catch {
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }

    const body = IngestBody.parse(request.body ?? {});
    insertLevel(body.level, { difficulty: body.meta.difficulty, seed: body.meta.seed });
    reply.status(201).send({ id: body.level.id });
  });

  server.post('/internal/jobs', async (request, reply) => {
    try {
      requireInternalToken(request);
    } catch {
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }

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
    try {
      requireInternalToken(request);
    } catch {
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }

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
    try {
      requireInternalToken(request);
    } catch {
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }

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
    try {
      requireInternalToken(request);
    } catch {
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }

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
    try {
      requireInternalToken(request);
    } catch {
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }

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
    try {
      requireInternalToken(request);
    } catch {
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }

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
