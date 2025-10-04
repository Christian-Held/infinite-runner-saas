import { makeLogger } from '@pkg/logger';

export const logger = makeLogger('playtester');

export type Logger = typeof logger;
