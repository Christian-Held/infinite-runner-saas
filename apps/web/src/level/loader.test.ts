import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchLevelMeta, fetchLevelPath } from './loader';

const originalFetch = globalThis.fetch;

describe('level loader 404 handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null when level meta is not found', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404, ok: false, json: async () => ({}) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchLevelMeta('missing');
    expect(result).toBeNull();
  });

  it('returns null when level path is not found', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404, ok: false, json: async () => ({}) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchLevelPath('missing');
    expect(result).toBeNull();
  });
});
