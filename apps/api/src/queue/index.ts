import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

import { Ability } from '@ir/game-spec';
import { z } from 'zod';

import { insertJob, updateJobStatus, upsertSeasonJob } from '../db';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

type AbilityInput = z.input<typeof Ability>;

export interface GenJobData {
  seed?: string;
  difficulty?: number;
  abilities?: AbilityInput;
  seasonId?: string;
  levelNumber?: number;
}

export interface QueueManager {
  enqueueGen(input: GenJobData): Promise<string>;
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function createQueueManager(): Promise<QueueManager> {
  const connection = new IORedis(REDIS_URL);

  const genQueue = new Queue<GenJobData>('gen', {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });

  async function enqueueGen(input: GenJobData): Promise<string> {
    const jobId = uuidv4();
    await insertJob({ id: jobId, type: 'gen', status: 'queued' });
    if (input.seasonId && typeof input.levelNumber === 'number') {
      upsertSeasonJob({
        seasonId: input.seasonId,
        levelNumber: input.levelNumber,
        jobId,
        status: 'queued',
      });
    }
    try {
      await genQueue.add('generate-level', input, { jobId });
    } catch (error) {
      const message = resolveErrorMessage(error);
      await updateJobStatus(jobId, 'failed', { error: message });
      throw error;
    }
    return jobId;
  }

  async function isHealthyRedis(): Promise<boolean> {
    try {
      await connection.ping();
      return true;
    } catch {
      return false;
    }
  }

  async function close() {
    await Promise.allSettled([genQueue.close()]);
    try {
      await connection.quit();
    } catch {
      connection.disconnect();
    }
  }

  return {
    enqueueGen,
    isHealthy: isHealthyRedis,
    close,
  };
}
