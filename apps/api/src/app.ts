import 'dotenv/config';

import IORedis from 'ioredis';
import process from 'node:process';

import { openDb } from './db';
import { migrate } from './db/migrate';
import { buildServer } from './server';

async function bootstrap() {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

  const db = openDb();
  await migrate(db);

  const redis = new IORedis(redisUrl);
  let lastRedisErrorLoggedAt = 0;
  const onRedisError = (error: Error) => {
    const now = Date.now();
    if (now - lastRedisErrorLoggedAt > 5000) {
      lastRedisErrorLoggedAt = now;
      console.error('Redis connection error:', error);
    }
  };
  redis.on('error', onRedisError);
  const server = buildServer({ db, redis });

  let shuttingDown = false;

  const closeResources = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}, closing ...`);

    try {
      await server.close();
      console.log('server closed');
    } catch (error) {
      console.error('Error while closing server:', error);
    }

    try {
      redis.off('error', onRedisError);
      redis.disconnect();
    } catch (error) {
      console.error('Error while disconnecting redis:', error);
    }

    try {
      db.close();
    } catch (error) {
      console.error('Error while closing database:', error);
    }

    console.log('closing ... done');
    process.exit(0);
  };

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, (received) => {
      closeResources(received).catch((error) => {
        console.error('Error during shutdown:', error);
        process.exit(1);
      });
    });
  }

  try {
    await server.listen({ host, port });
  } catch (error) {
    console.error('Failed to start HTTP server:', error);
    try {
      redis.off('error', onRedisError);
      redis.disconnect();
    } catch (redisError) {
      console.error('Error while disconnecting redis after listen failure:', redisError);
    }

    try {
      db.close();
    } catch (dbError) {
      console.error('Error while closing database after listen failure:', dbError);
    }

    throw error;
  }
  server.log.info(`API listening on :${port}`);
}

async function main() {
  try {
    await bootstrap();
  } catch (error) {
    console.error('Failed to start API', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Unhandled error while starting API', error);
    process.exit(1);
  });
}
