import { vi } from 'vitest';

vi.mock('openai', () => {
  class FakeClient {
    embeddings = {
      create: vi.fn().mockResolvedValue({ data: [{ embedding: [0, 0, 0] }] }),
    };
    chats = {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
      },
    };
  }
  return { OpenAI: FakeClient };
});

vi.mock('@pkg/logger', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = {
    info: vi.fn(noop),
    warn: vi.fn(noop),
    error: vi.fn(noop),
    debug: vi.fn(noop),
    trace: vi.fn(noop),
    fatal: vi.fn(noop),
  };
  (logger as { child: ReturnType<typeof vi.fn> }).child = vi.fn(() => logger);
  (logger as { flush: ReturnType<typeof vi.fn> }).flush = vi.fn();

  return {
    makeLogger: vi.fn(() => logger),
    getLogFilePath: vi.fn(() => null),
    closeLogger: vi.fn(),
  };
});
