import cors from '@fastify/cors';
import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import type IORedis from 'ioredis';
import pino from 'pino';

import { pingDb } from './db';

interface BuildServerOptions {
  db: Database.Database;
  redis: IORedis;
}

export function buildServer({ db, redis }: BuildServerOptions) {
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

  const noopResponse = { status: 'not-implemented' } as const;

  server.all('/levels', async () => noopResponse);
  server.all('/levels/:id', async () => noopResponse);
  server.all('/jobs/:id', async () => noopResponse);
  server.all('/levels/:id/publish', async () => noopResponse);
  server.all('/levels/generate', async () => noopResponse);
  server.all('/internal/levels', async () => noopResponse);
  server.all('/internal/jobs', async () => noopResponse);
  server.all('/internal/jobs/:id/status', async () => noopResponse);

  server.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ status: 'not-found' });
  });

  return server;
}
