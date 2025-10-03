import 'dotenv/config';

import { createLogger, bindUnhandled } from '@ir/logger';

import { startMetricsServer } from './metrics-server';
import { startWorkers } from './queue';

async function bootstrap() {
  const logger = createLogger('playtester');
  bindUnhandled(logger);

  const runtime = await startWorkers(logger);
  logger.info('Workers for gen/test queues started');

  const metricsPort = Number.parseInt(process.env.METRICS_PORT ?? '9100', 10);
  const metricsServer = await startMetricsServer(metricsPort);
  logger.info({ port: metricsPort }, 'Metrics server listening');

  if (!process.env.OPENAI_API_KEY) {
    logger.error(
      'OPENAI_API_KEY is not set. Please configure services/playtester/.env and restart.',
    );
    await runtime
      .close()
      .catch((error) => logger.error({ err: error }, 'Failed to close runtime after missing API key'));
    await metricsServer
      .close()
      .catch((error) => logger.error({ err: error }, 'Failed to stop metrics server'));
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.warn({ signal }, 'Received shutdown signal');
    try {
      await runtime.close();
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
    }
    try {
      await metricsServer.close();
    } catch (error) {
      logger.error({ err: error }, 'Failed to close metrics server');
    }
    process.exit(0);
  };

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.once(signal, () => {
      shutdown(signal).catch((error) => {
        logger.fatal({ err: error }, 'Shutdown failure');
        process.exit(1);
      });
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((error) => {
    const logger = createLogger('playtester');
    logger.fatal({ err: error }, 'Fatal error during startup');
    process.exit(1);
  });
}

export { bootstrap };
