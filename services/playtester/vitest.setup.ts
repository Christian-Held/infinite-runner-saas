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
