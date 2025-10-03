import http from 'node:http';

import { registry } from './metrics';

export interface MetricsServerHandle {
  close(): Promise<void>;
}

export async function startMetricsServer(port: number): Promise<MetricsServerHandle> {
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request' }));
      return;
    }

    if (req.url === '/metrics') {
      try {
        const metrics = await registry.metrics();
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(metrics);
        return;
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'collect_failed' }));
        return;
      }
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime_s: Math.round(process.uptime()) }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '0.0.0.0', (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return {
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
