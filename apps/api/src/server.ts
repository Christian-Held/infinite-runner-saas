import cors from '@fastify/cors';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import pino from 'pino';
import { z } from 'zod';

import { Ability, Level } from '@ir/game-spec';

import {
  getJob,
  getLevel,
  getLevelPath,
  insertJob,
  insertLevel,
  pingDb,
  upsertLevelPath,
  updateJobStatus,
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

  server.get('/levels/:id', async (request, reply) => {
    const id = z.string().parse((request.params as any).id);
    const level = getLevel(id);
    if (!level) {
      reply.status(404).send({ error: 'not_found' });
      return;
    }
    reply.send(level);
  });

  server.get('/levels/:id/path', async (request, reply) => {
    const id = z.string().parse((request.params as any).id);
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

  server.get('/jobs/:id', async (request, reply) => {
    const id = z.string().parse((request.params as any).id);
    const job = getJob(id);
    if (!job) {
      reply.status(404).send({ error: 'not_found' });
      return;
    }
    reply.send(job);
  });

  server.post('/internal/levels', async (request, reply) => {
    try {
      requireInternalToken(request);
    } catch (error) {
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
    } catch (error) {
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }

    const body = InternalJobBody.parse(request.body ?? {});
    insertJob({ id: body.id, type: body.type, status: body.status, level_id: body.levelId ?? null });
    reply.status(204).send();
  });

  server.post('/internal/jobs/:id/status', async (request, reply) => {
    try {
      requireInternalToken(request);
    } catch (error) {
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }

    const id = z.string().parse((request.params as any).id);
    const body = UpdateJobBody.parse(request.body ?? {});
    updateJobStatus(id, body.status, { error: body.error ?? undefined, levelId: body.levelId });
    reply.status(204).send();
  });

  server.post('/internal/levels/path', async (request, reply) => {
    try {
      requireInternalToken(request);
    } catch (error) {
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

  server.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ status: 'not-found' });
  });

  return server;
}
