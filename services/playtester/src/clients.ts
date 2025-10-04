import IORedis from 'ioredis';
import OpenAI from 'openai';

import { cfg } from './config';

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const OPENAI_REQ_TIMEOUT_MS = Number(process.env.OPENAI_REQ_TIMEOUT_MS ?? '20000');

let openaiClient: OpenAI | null = null;
let redisClient: IORedis | null = null;

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
    redisClient = new IORedis(cfg.redisUrl, {
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
