import 'dotenv/config';

import { startWorkers } from './queue';

async function bootstrap() {
  const runtime = await startWorkers();
  console.log('[playtester] Workers for gen/test queues started');

  if (!process.env.OPENAI_API_KEY) {
    console.error(
      '[playtester] OPENAI_API_KEY is not set. Please configure services/playtester/.env and restart.',
    );
    await runtime
      .close()
      .catch((error) =>
        console.error('[playtester] Failed to close runtime after missing API key', error),
      );
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[playtester] Received ${signal}, shutting down workers`);
    try {
      await runtime.close();
    } catch (error) {
      console.error('[playtester] Error during shutdown', error);
    } finally {
      process.exit(0);
    }
  };

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.once(signal, () => {
      shutdown(signal).catch((error) => {
        console.error('[playtester] Shutdown failure', error);
        process.exit(1);
      });
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((error) => {
    console.error('[playtester] Fatal error during startup', error);
    process.exit(1);
  });
}

export { bootstrap };
