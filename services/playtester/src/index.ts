import 'dotenv/config';

import { cfg } from './config';
import { startWorkers, stopWorkers } from './queue';
import { logger } from './logger';

async function main() {
  logger.info(
    {
      redisUrl: cfg.redisUrl,
      prefix: cfg.bullPrefix,
      genQueue: cfg.genQueue,
      testQueue: cfg.testQueue,
    },
    'Booting playtester workers',
  );

  await startWorkers();
  logger.info('Playtester workers ready');

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Received shutdown signal');
    try {
      await stopWorkers();
    } catch (error) {
      logger.error({ err: error }, 'Failed to stop workers cleanly');
    } finally {
      process.exit(0);
    }
  };

  (['SIGINT', 'SIGTERM'] as const).forEach((signal) => {
    process.once(signal, () => {
      shutdown(signal).catch((error) => {
        logger.fatal({ err: error }, 'Unexpected shutdown error');
        process.exit(1);
      });
    });
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start playtester workers');
  stopWorkers()
    .catch((err) => logger.error({ err }, 'Failed to stop workers after startup failure'))
    .finally(() => process.exit(1));
});
