export const QUEUE_NAMES = ['gen', 'test'] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export const DEFAULT_QUEUE_PREFIX = 'bull';

export interface QueueConfigOptions {
  prefix?: string | null | undefined;
}

export interface ResolvedQueueConfig {
  names: readonly QueueName[];
  prefix: string;
}

export function resolveQueueConfig(options: QueueConfigOptions = {}): ResolvedQueueConfig {
  const prefixCandidate = typeof options.prefix === 'string' ? options.prefix.trim() : '';
  const prefix = prefixCandidate.length > 0 ? prefixCandidate : DEFAULT_QUEUE_PREFIX;
  return { names: QUEUE_NAMES, prefix };
}
