import Fastify from 'fastify';

const server = Fastify({
  logger: true,
});

server.get('/health', async () => ({ status: 'ok' }));

const port = Number(process.env.PORT) || 3000;

async function start() {
  try {
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`API listening on http://localhost:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export default server;
