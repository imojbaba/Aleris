import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { env } from './env.js';
import { registerRoutes } from './routes/index.js';
import { MemoryRepo, MemoryLocks, nodeTokens } from './adapters/memory.js';
import { MemoryStore } from './adapters/memoryStore.js';
import { PrismaRepo, PostgresLocks, createPrismaClient } from './adapters/prisma.js';
import { PrismaStore } from './adapters/prismaStore.js';
import { buildNotifier } from './adapters/notifiers/index.js';
import { ReleaseEngine } from './domain/releaseEngine.js';
import { systemClock, type Locks, type TriggerRepository } from './domain/ports.js';
import type { AppStore } from './domain/appStore.js';

export async function buildServer() {
  const app = Fastify({ logger: { level: env.isProd ? 'info' : 'debug' } });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: env.jwtSecret });
  /**
   * The wellbeing and claim endpoints are unauthenticated by necessity — the
   * people using them are members of the public holding a one-time link — so a
   * rate limit is the only thing between a token and a brute-force.
   */
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  let store: AppStore;
  let repo: TriggerRepository;
  let locks: Locks;
  let disconnect = async () => {};

  if (env.databaseUrl) {
    const db = createPrismaClient(env.databaseUrl);
    store = new PrismaStore(db);
    repo = new PrismaRepo(db);
    locks = new PostgresLocks(db);
    disconnect = () => db.$disconnect();
  } else {
    // No database configured: run entirely in memory, so the whole service
    // starts on a laptop with nothing installed.
    store = new MemoryStore();
    repo = new MemoryRepo();
    locks = new MemoryLocks();
  }

  await registerRoutes(app, { store, tokens: nodeTokens, now: () => Date.now() });

  const { notifier, live, dryRun } = buildNotifier(env.notifiers, (l) => app.log.info(l));
  app.log.info(
    `storage: ${env.storage} | channels live: ${live.length ? live.join(', ') : 'none'} | ` +
    `dry-run (logged, NOT sent): ${dryRun.join(', ')}`,
  );

  const engine = new ReleaseEngine({
    repo, notifier, clock: systemClock, locks, tokens: nodeTokens,
    appBaseUrl: env.appBaseUrl,
  });

  app.addHook('onClose', async () => disconnect());

  return { app, engine, repo, store, channels: { live, dryRun } };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  const { app, engine } = await buildServer();

  // In development the worker runs in-process. In production it is a separate
  // deployment (src/worker.ts) so a slow release cannot starve the API.
  if (!env.isProd) {
    setInterval(() => {
      engine.tick().catch((e) => app.log.error({ err: e }, 'worker tick failed'));
    }, env.workerIntervalMs).unref();
  }

  await app.listen({ port: env.port, host: env.host });
  app.log.info(`Vigil API listening on ${env.host}:${env.port}`);
}
