import dotenv from 'dotenv';
import IORedis from 'ioredis';
import process from 'node:process';

import { createLogger, bindUnhandled } from '@ir/logger';

import { loadConfig, requireProdSecrets } from './config';
import { openDb } from './db';
import { migrate } from './db/migrate';
import { createQueueManager } from './queue';
import { buildServer } from './server';

dotenv.config();

async function bootstrap() {
  const logger = createLogger('api');
  bindUnhandled(logger);

  const config = loadConfig();
  requireProdSecrets(config);

  const db = openDb();
  await migrate(db);

  const redis = new IORedis(config.redisUrl);
  let lastRedisErrorLoggedAt = 0;
  const redisLogger = logger.child({ module: 'redis' });
  const onRedisError = (error: Error) => {
    const now = Date.now();
    if (now - lastRedisErrorLoggedAt > 5000) {
      lastRedisErrorLoggedAt = now;
      redisLogger.error({ err: error }, 'Redis connection error');
    }
  };
  redis.on('error', onRedisError);

  const queueManager = await createQueueManager();
  const internalToken = config.internalToken ?? 'dev-internal';
  const server = buildServer({
    db,
    redis,
    queueManager,
    logger,
    config,
    internalToken,
  });

  let shuttingDown = false;

  const closeResources = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.warn({ signal }, 'Shutdown signal received');

    try {
      await server.close();
      logger.info('HTTP server closed');
    } catch (error) {
      logger.error({ err: error }, 'Error while closing server');
    }

    try {
      await queueManager.close();
    } catch (error) {
      logger.error({ err: error }, 'Error while closing queue manager');
    }

    try {
      redis.off('error', onRedisError);
      redis.disconnect();
    } catch (error) {
      logger.error({ err: error }, 'Error while disconnecting redis');
    }

    try {
      db.close();
    } catch (error) {
      logger.error({ err: error }, 'Error while closing database');
    }

    logger.info('Shutdown complete');
    process.exit(0);
  };

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, (received) => {
      closeResources(received).catch((error) => {
        logger.fatal({ err: error }, 'Error during shutdown');
        process.exit(1);
      });
    });
  }

  try {
    await server.listen({ host: config.host, port: config.port });
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start HTTP server');
    try {
      await queueManager.close();
    } catch (queueError) {
      logger.error({ err: queueError }, 'Error while closing queue manager after listen failure');
    }

    try {
      redis.off('error', onRedisError);
      redis.disconnect();
    } catch (redisError) {
      logger.error({ err: redisError }, 'Error while disconnecting redis after listen failure');
    }

    try {
      db.close();
    } catch (dbError) {
      logger.error({ err: dbError }, 'Error while closing database after listen failure');
    }

    throw error;
  }

  logger.info({ port: config.port, host: config.host }, 'API listening');
  server.log.info(`API listening on :${config.port}`);
}

async function main() {
  try {
    await bootstrap();
  } catch (error) {
    const logger = createLogger('api');
    logger.fatal({ err: error }, 'Fatal error during bootstrap');
    process.exit(1);
  }
}

void main();
