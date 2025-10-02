import IORedis from 'ioredis';
import OpenAI from 'openai';

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const OPENAI_REQ_TIMEOUT_MS = Number(process.env.OPENAI_REQ_TIMEOUT_MS ?? '20000');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

let openaiClient: OpenAI | null = null;
let redisClient: IORedis | null = null;

export function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
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
    redisClient = new IORedis(REDIS_URL, {
      enableOfflineQueue: false,
    });
  }

  return redisClient;
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
