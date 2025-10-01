import cors from '@fastify/cors';
import Fastify from 'fastify';
import pino from 'pino';
import { ZodError, z } from 'zod';

import { Ability, Level } from '@ir/game-spec';

import { getJob, getLevel, isDbHealthy, listLevels, setPublished } from './db';
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
