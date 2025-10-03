import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const queueJobsTotal = new Counter({
  name: 'queue_jobs_total',
  help: 'Total number of queue jobs processed',
  labelNames: ['queue', 'status'],
  registers: [registry],
});

export const queueJobsDurationSeconds = new Histogram({
  name: 'queue_jobs_duration_seconds',
  help: 'Duration of queue jobs in seconds',
  labelNames: ['queue'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export function recordQueueJob(
  queue: string,
  status: string,
  startedAt?: bigint,
): void {
  queueJobsTotal.labels(queue, status).inc();
  if (startedAt) {
    const diffNs = Number(process.hrtime.bigint() - startedAt);
    const diffSeconds = diffNs / 1_000_000_000;
    queueJobsDurationSeconds.labels(queue).observe(diffSeconds);
  }
}
