import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pino, { multistream, type Logger as PinoLogger, type StreamEntry } from 'pino';

const packageDirectory = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = path.resolve(packageDirectory, '..', '..', '..');

const managedLoggers = new Map<string, ManagedLogger>();

interface ManagedLogger {
  logger: Logger;
  fileStream: fs.WriteStream;
  filePath: string;
  cleanup: () => void;
}

function resolveLogRoot(): string {
  const configured = process.env.LOG_DIR?.trim();
  if (configured && configured.length > 0) {
    return path.resolve(configured);
  }
  return path.join(repositoryRoot, 'logs');
}

function shouldCleanLogsOnStart(): boolean {
  const explicit = process.env.CLEAN_LOGS_ON_START?.trim();
  if (explicit === '0') {
    return false;
  }
  if (explicit === '1') {
    return true;
  }
  return (process.env.NODE_ENV ?? '').toLowerCase() !== 'production';
}

function createRunFileName(): string {
  const iso = new Date().toISOString().replace(/[:]/g, '-').replace(/\./g, '-');
  return `run-${iso}-${process.pid}.log`;
}

function prepareServiceLogFile(serviceName: string): { filePath: string; stream: fs.WriteStream } {
  const logRoot = resolveLogRoot();
  const serviceDir = path.join(logRoot, serviceName);

  if (shouldCleanLogsOnStart()) {
    try {
      fs.rmSync(serviceDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Failed to clean logs for ${serviceName}:`, error);
    }
  }

  fs.mkdirSync(serviceDir, { recursive: true });

  const fileName = createRunFileName();
  const filePath = path.join(serviceDir, fileName);
  const stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
  return { filePath, stream };
}

function flushStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.closed) {
      resolve();
      return;
    }

    stream.write('', 'utf8', () => {
      if (stream.writableNeedDrain) {
        stream.once('drain', () => resolve());
        return;
      }
      resolve();
    });
  });
}

function registerProcessHandlers(logger: Logger, fileStream: fs.WriteStream): () => void {
  let shuttingDown = false;

  const handleRejection = (reason: unknown, _promise: Promise<unknown>) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  };

  const handleException = (error: Error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
  };

  const handleSigint = (signal: NodeJS.Signals) => {
    if (signal !== 'SIGINT') {
      return;
    }
    logger.warn({ signal }, 'SIGINT received');
  };

  const handleSigterm = (signal: NodeJS.Signals) => {
    if (signal !== 'SIGTERM') {
      return;
    }
    logger.warn({ signal }, 'SIGTERM received');
  };

  const handleBeforeExit = async (code: number) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ code }, 'Process exiting, flushing logs');
    try {
      logger.flush?.();
      await flushStream(fileStream);
    } catch (error) {
      logger.error({ err: error }, 'Failed to flush logs on exit');
    }
  };

  process.on('unhandledRejection', handleRejection);
  process.on('uncaughtException', handleException);
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  process.on('beforeExit', handleBeforeExit);

  return () => {
    process.off('unhandledRejection', handleRejection);
    process.off('uncaughtException', handleException);
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    process.off('beforeExit', handleBeforeExit);
  };
}

export type Logger = PinoLogger;

export function makeLogger(serviceName: string): Logger {
  const existing = managedLoggers.get(serviceName);
  if (existing) {
    return existing.logger;
  }

  const { filePath, stream } = prepareServiceLogFile(serviceName);
  const level = (process.env.LOG_LEVEL ?? 'debug').toLowerCase();
  const streams: StreamEntry[] = [
    { stream: process.stdout },
    { stream },
  ];

  const baseLogger = pino(
    {
      level,
      base: {
        service: serviceName,
        pid: process.pid,
        hostname: os.hostname(),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    multistream(streams),
  );

  const cleanup = registerProcessHandlers(baseLogger, stream);
  managedLoggers.set(serviceName, {
    logger: baseLogger,
    fileStream: stream,
    filePath,
    cleanup,
  });

  return baseLogger;
}

export function getLogFilePath(serviceName: string): string | null {
  const entry = managedLoggers.get(serviceName);
  return entry?.filePath ?? null;
}

export function closeLogger(serviceName: string): void {
  const entry = managedLoggers.get(serviceName);
  if (!entry) {
    return;
  }

  entry.cleanup();
  try {
    entry.logger.flush?.();
  } catch {
    // ignore flush errors during shutdown
  }
  try {
    entry.fileStream.end();
  } catch {
    // ignore errors when closing the stream
  }
  managedLoggers.delete(serviceName);
}
