import { createServer } from './server';
import { closeDb, initDb, migrate } from './db';
import { createQueueManager } from './queue';

async function bootstrap() {
  initDb();
  migrate();
  const queueManager = await createQueueManager();
  const server = createServer({ queueManager });

  const port = Number(process.env.PORT ?? 3000);
  await server.listen({ port, host: '0.0.0.0' });
  server.log.info(`API listening on http://localhost:${port}`);

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.log.info({ signal }, 'Received shutdown signal');
    try {
      await server.close();
      await queueManager.close();
    } catch (error) {
      server.log.error({ err: error }, 'Error while closing resources');
    } finally {
      closeDb();
      process.exit(0);
    }
  }

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.once(signal, () => {
      shutdown(signal).catch((error) => {
        server.log.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      });
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { bootstrap };
