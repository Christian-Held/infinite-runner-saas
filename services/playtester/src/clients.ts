import IORedis from 'ioredis';
import OpenAI from 'openai';

import { cfg, getConfig } from './config';
import { logger } from './logger';

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const OPENAI_REQ_TIMEOUT_MS = Number(process.env.OPENAI_REQ_TIMEOUT_MS ?? '20000');

let openaiClient: OpenAI | null = null;
let redisClient: IORedis | null = null;

const redisLogger = logger.child({ module: 'redis-client' });

export function getOpenAIClient(): OpenAI {
  const apiKey = cfg.openaiKey;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey,
      timeout: OPENAI_REQ_TIMEOUT_MS,
    });
  }

  return openaiClient;
}

export function getRedisClient(): IORedis {
  if (!redisClient) {
    const config = getConfig();
    redisClient = new IORedis(config.redisUrl, {
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    redisClient.on('error', (err) => {
      redisLogger.error({ err }, 'Redis client error');
    });
    redisClient.on('ready', () => {
      redisLogger.info({ redisUrl: config.redisUrl }, 'Redis client ready');
    });
    redisClient.on('end', () => {
      redisLogger.warn('Redis client connection ended');
    });
    redisClient.on('reconnecting', (delay) => {
      redisLogger.warn({ delay }, 'Redis client reconnecting');
    });
  }

  return redisClient;
}

export async function getReadyRedis(): Promise<IORedis> {
  const client = getRedisClient();
  if (client.status === 'ready') {
    return client;
  }

  if (client.status === 'wait' || client.status === 'end' || client.status === 'close') {
    try {
      await client.connect();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (!/already connecting|connected/i.test(message)) {
        throw err;
      }
    }
  }

  if (client.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        client.off('error', onError);
        resolve();
      };
      const onError = (err: unknown) => {
        client.off('ready', onReady);
        reject(err);
      };

      client.once('ready', onReady);
      client.once('error', onError);
    });
  }
  return client;
}

export function getClients(): { openai: OpenAI; redis: IORedis } {
  return { openai: getOpenAIClient(), redis: getRedisClient() };
}

export async function closeClients(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      redisClient.disconnect();
    } finally {
      redisClient = null;
    }
  }

  openaiClient = null;
}

export function getModel(): string {
  return OPENAI_MODEL;
}
