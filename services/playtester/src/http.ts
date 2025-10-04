import { setTimeout as delay } from 'node:timers/promises';

import type { Logger } from '@ir/logger';

import { cfg } from './config';

interface FetchJsonOptions {
  method?: string;
  path: string;
  body?: unknown;
  logger: Logger;
  internal?: boolean;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 100;

export async function fetchJson<T = unknown>({
  method = 'GET',
  path,
  body,
  logger,
  internal = true,
}: FetchJsonOptions): Promise<T> {
  const url = path.startsWith('http') ? path : `${cfg.apiBase}${path}`;
  const headers: Record<string, string> = {};
  if (internal) {
    headers['x-internal-token'] = cfg.internalToken;
  }
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const started = process.hrtime.bigint();
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      logger.info({ method, path, status: response.status, durationMs }, 'HTTP request');

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      if (response.status === 204 || response.status === 205) {
        return undefined as T;
      }

      const text = await response.text();
      if (!text) {
        return undefined as T;
      }
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new Error(`Failed to parse JSON response: ${(error as Error).message}`);
      }
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS - 1) {
        const delayMs = BASE_DELAY_MS * 2 ** attempt;
        await delay(delayMs);
        continue;
      }
      break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
