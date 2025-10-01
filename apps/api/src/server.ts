import cors from '@fastify/cors';
import Fastify, { type FastifyRequest } from 'fastify';
import pino from 'pino';
import { ZodError, z } from 'zod';

import { Ability, Level } from '@ir/game-spec';

import {
  getJob,
  getLevel,
  insertJob,
  insertLevel,
  isDbHealthy,
  listLevels,
  setPublished,
  updateJobStatus,
} from './db';
import type { QueueManager } from './queue';

const PublishBodySchema = z.object({
  published: z.boolean(),
});

const GenerateBodySchema = z
  .object({
    seed: z.string().optional(),
    difficulty: z.coerce.number().int().min(1).optional(),
    abilities: Ability.optional(),
  })
  .optional();

const ListQuerySchema = z.object({
  published: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const InternalLevelSchema = z.object({
  level: Level,
  meta: z.object({
    difficulty: z.number().int().min(1),
    seed: z.string(),
  }),
});

const JobStatusSchema = z.enum(['queued', 'running', 'failed', 'succeeded']);

const InternalJobCreateSchema = z.object({
  id: z.string(),
  type: z.enum(['gen', 'test']),
  status: JobStatusSchema.default('queued'),
  levelId: z.string().nullable().optional(),
});

const InternalJobUpdateSchema = z.object({
  status: JobStatusSchema,
  error: z.string().nullable().optional(),
  levelId: z.string().optional(),
});

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal';

function assertInternal(request: FastifyRequest) {
  const token = request.headers['x-internal-token'];
  if (token !== INTERNAL_TOKEN) {
    const error = new Error('Missing or invalid internal token');
    (error as any).statusCode = 401;
    throw error;
  }
}

export interface ServerDependencies {
  queueManager: QueueManager;
}

export function createServer({ queueManager }: ServerDependencies) {
  const server = Fastify({
    logger: pino({ level: process.env.LOG_LEVEL ?? 'info' }),
  });

  server.register(cors, {
    origin: 'http://localhost:5173',
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      request.log.warn({ err: error }, 'Validation error');
      return reply.status(400).send({
        message: 'Validation error',
        issues: error.flatten(),
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    reply.status(statusCode).send({ message: error.message ?? 'Internal Server Error' });
  });

  server.get('/health', async () => {
    const redisHealthy = await queueManager.isHealthy();
    return {
      status: 'ok',
      db: isDbHealthy(),
      redis: redisHealthy,
      worker: false,
    };
  });

  server.get('/levels/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const level = getLevel(params.id);
    if (!level) {
      return reply.status(404).send({ message: 'Level not found' });
    }

    return Level.parse(level);
  });

  server.get('/levels', async (request) => {
    const query = ListQuerySchema.parse(request.query);
    const levels = listLevels({
      published: typeof query.published === 'string' ? query.published === 'true' : undefined,
      limit: query.limit,
      offset: query.offset,
    });

    return {
      levels: levels.map((entry) => ({
        level: Level.parse(entry.level),
        published: entry.published,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })),
    };
  });

  server.post('/levels/:id/publish', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = PublishBodySchema.parse(request.body);

    const updated = setPublished(params.id, body.published);
    if (!updated) {
      return reply.status(404).send({ message: 'Level not found' });
    }

    return { id: params.id, published: body.published };
  });

  server.post('/levels/generate', async (request) => {
    const body = GenerateBodySchema.parse(request.body) ?? {};
    const jobId = await queueManager.enqueueGen({
      seed: body.seed,
      difficulty: body.difficulty,
      abilities: body.abilities,
    });
    return { jobId };
  });

  server.post('/internal/levels', async (request) => {
    assertInternal(request);
    const body = InternalLevelSchema.parse(request.body);
    const level = Level.parse(body.level);
    insertLevel(level, { difficulty: body.meta.difficulty, seed: body.meta.seed });
    return { id: level.id };
  });

  server.post('/internal/jobs', async (request) => {
    assertInternal(request);
    const body = InternalJobCreateSchema.parse(request.body);
    insertJob({ id: body.id, type: body.type, status: body.status, level_id: body.levelId ?? null });
    return { id: body.id };
  });

  server.post('/internal/jobs/:id/status', async (request) => {
    assertInternal(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = InternalJobUpdateSchema.parse(request.body);
    updateJobStatus(params.id, body.status, { error: body.error ?? undefined, levelId: body.levelId });
    return { id: params.id, status: body.status };
  });

  server.get('/jobs/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const job = getJob(params.id);
    if (!job) {
      return reply.status(404).send({ message: 'Job not found' });
    }

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      level_id: job.levelId ?? undefined,
      error: job.error ?? undefined,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  });

  return server;
}
