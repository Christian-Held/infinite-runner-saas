import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Writable } from 'node:stream';

import pino, { multistream, type Logger as PinoLogger, type StreamEntry } from 'pino';

const LOG_DIRECTORY = path.resolve(process.cwd(), '.logs');

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

class RotatingFileStream extends Writable {
  private currentDate: string | null = null;

  private destination: fs.WriteStream | null = null;

  constructor(private readonly serviceName: string) {
    super({ decodeStrings: false });
    fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
  }

  private openStream(): void {
    const today = formatDate(new Date());
    if (this.currentDate === today && this.destination) {
      return;
    }

    this.currentDate = today;
    const filePath = path.join(LOG_DIRECTORY, `${this.serviceName}-${today}.log`);
    if (this.destination) {
      this.destination.end();
    }
    this.destination = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
  }

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.openStream();
    if (!this.destination) {
      callback(new Error('Failed to open log file destination'));
      return;
    }

    const writable = this.destination.write(chunk, encoding);
    if (writable) {
      callback();
      return;
    }
    this.destination.once('drain', callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.destination) {
      this.destination.end(() => {
        this.destination = null;
        callback(error);
      });
      return;
    }
    callback(error);
  }
}

export interface BindUnhandledOptions {
  exitOnFatal?: boolean;
}

export type Logger = PinoLogger;

export function createLogger(serviceName: string): Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  const fileStream = new RotatingFileStream(serviceName);
  const streams: StreamEntry[] = [
    { stream: process.stdout },
    { stream: fileStream },
  ];

  const baseLogger = pino(
    {
      level,
      base: {
        service: serviceName,
        pid: process.pid,
        hostname: os.hostname(),
      },
    },
    multistream(streams),
  );

  return baseLogger;
}

export function bindUnhandled(logger: Logger, options: BindUnhandledOptions = {}): () => void {
  const { exitOnFatal = true } = options;

  const handleRejection = (reason: unknown) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
    if (exitOnFatal) {
      process.exit(1);
    }
  };

  const handleException = (error: Error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    if (exitOnFatal) {
      process.exit(1);
    }
  };

  process.on('unhandledRejection', handleRejection);
  process.on('uncaughtException', handleException);

  return () => {
    process.off('unhandledRejection', handleRejection);
    process.off('uncaughtException', handleException);
  };
}
