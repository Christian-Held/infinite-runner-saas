import { Level, LevelT } from '@ir/game-spec';
import { z } from 'zod';

import { InputCmd } from './sim/arcade';

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal';
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';

const JobStatusSchema = z.enum(['queued', 'running', 'failed', 'succeeded']);
const JobTypeSchema = z.enum(['gen', 'test']);

export interface IngestLevelPayload {
  level: LevelT;
  difficulty: number;
  seed: string;
}

export async function ingestLevel(payload: IngestLevelPayload): Promise<{ id: string }> {
  const response = await fetch(`${API_BASE_URL}/internal/levels`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      level: Level.parse(payload.level),
      meta: {
        difficulty: payload.difficulty,
        seed: payload.seed,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to ingest level: ${response.status} ${text}`);
  }

  return response.json() as Promise<{ id: string }>;
}

export async function createJobRecord(params: {
  id: string;
  type: z.infer<typeof JobTypeSchema>;
  status?: z.infer<typeof JobStatusSchema>;
  levelId?: string | null;
}): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/internal/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      id: params.id,
      type: JobTypeSchema.parse(params.type),
      status: JobStatusSchema.parse(params.status ?? 'queued'),
      levelId: params.levelId ?? null,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create job record: ${response.status} ${text}`);
  }
}

export async function updateJobStatus(params: {
  id: string;
  status: z.infer<typeof JobStatusSchema>;
  error?: string;
  levelId?: string;
  attempts?: number;
  lastReason?: string;
}): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/internal/jobs/${params.id}/status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      status: JobStatusSchema.parse(params.status),
      error: params.error ?? null,
      levelId: params.levelId,
      attempts: typeof params.attempts === 'number' ? params.attempts : undefined,
      lastReason: params.lastReason,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update job status: ${response.status} ${text}`);
  }
}

export async function fetchLevel(levelId: string): Promise<LevelT> {
  const response = await fetch(`${API_BASE_URL}/levels/${levelId}`, {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch level ${levelId}: ${response.status} ${text}`);
  }

  const data = await response.json();
  return Level.parse(data);
}

export async function submitLevelPath(params: { levelId: string; path: InputCmd[] }): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/internal/levels/path`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      level_id: params.levelId,
      path: params.path,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to submit level path: ${response.status} ${text}`);
  }
}

export async function submitLevelPatch(params: {
  levelId: string;
  patch: unknown;
  reason: string;
  level: LevelT;
}): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/internal/levels/patch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      level_id: params.levelId,
      patch: params.patch,
      reason: params.reason,
      level: Level.parse(params.level),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to submit level patch: ${response.status} ${text}`);
  }
}
