import cors from '@fastify/cors';
import Fastify from 'fastify';

import { Level, LevelT } from '@ir/game-spec';

const server = Fastify({
  logger: true,
});

server.register(cors, {
  origin: 'http://localhost:5173',
});

const DEMO_LEVEL: LevelT = {
  id: 'demo-01',
  seed: 'demo',
  rules: {
    abilities: {
      run: true,
      jump: true,
    },
    duration_target_s: 60,
    difficulty: 1,
  },
  tiles: [
    { x: 0, y: 620, w: 1200, h: 40, type: 'ground' },
    { x: 1350, y: 560, w: 220, h: 24, type: 'platform' },
    { x: 1700, y: 520, w: 220, h: 24, type: 'platform' },
    { x: 2050, y: 480, w: 220, h: 24, type: 'platform' },
    { x: 2500, y: 620, w: 800, h: 40, type: 'ground' },
    { x: 3450, y: 560, w: 220, h: 24, type: 'platform' },
    { x: 1200, y: 600, w: 120, h: 20, type: 'hazard' },
    { x: 3300, y: 600, w: 120, h: 20, type: 'hazard' },
  ],
  moving: [],
  items: [],
  enemies: [],
  checkpoints: [],
  exit: { x: 3800, y: 560 },
};

server.get('/health', async () => ({ status: 'ok' }));

server.get('/levels/demo', async (_, reply) => {
  const result = Level.safeParse(DEMO_LEVEL);

  if (!result.success) {
    server.log.error({ err: result.error }, 'Invalid demo level schema');
    return reply.status(500).send({
      error: 'Invalid level schema',
      detail: result.error.flatten(),
    });
  }

  return result.data;
});

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
