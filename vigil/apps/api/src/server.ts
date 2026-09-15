import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { env } from './env.js';
import { registerRoutes } from './routes/index.js';
import { MemoryRepo, RecordingNotifier, MemoryLocks, nodeTokens } from './adapters/memory.js';
import { ReleaseEngine } from './domain/releaseEngine.js';
import { systemClock } from './domain/ports.js';

export async function buildServer() {
  const app = Fastify({ logger: { level: env.isProd ? 'info' : 'debug' } });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: env.jwtSecret });
  // Release and confirm endpoints are unauthenticated by necessity; rate limits
  // are the only thing standing between a one-time link and a brute-force.
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  const repo = new MemoryRepo();
  await registerRoutes(app, { repo, tokens: nodeTokens, now: () => Date.now() });

  const engine = new ReleaseEngine({
    repo,
    notifier: new RecordingNotifier(),
    clock: systemClock,
    locks: new MemoryLocks(),
    tokens: nodeTokens,
    appBaseUrl: env.appBaseUrl,
  });

  return { app, engine, repo };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  const { app, engine } = await buildServer();

  // In development the worker runs in-process. In production it is a separate
  // deployment (see src/worker.ts) so that a slow release cannot starve the API.
  if (!env.isProd) {
    setInterval(() => {
      engine.tick().catch((e) => app.log.error({ err: e }, 'worker tick failed'));
    }, env.workerIntervalMs).unref();
  }

  await app.listen({ port: env.port, host: env.host });
  app.log.info(`Vigil API listening on ${env.host}:${env.port} (storage: ${env.storage})`);
}
