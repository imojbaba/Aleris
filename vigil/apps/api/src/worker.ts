import { env } from './env.js';
import { buildServer } from './server.js';

/**
 * The cadence worker, deployed separately from the API.
 *
 * It is the only process that can cause a release, so it is the one to watch:
 * alert on a tick that has not completed in ten minutes, because a worker that
 * silently stops is a product that silently stops keeping its promise, and
 * nobody on the outside would ever notice.
 */
const { engine } = await buildServer();

let running = false;
setInterval(async () => {
  if (running) return; // Never overlap: overlapping ticks race on the same triggers.
  running = true;
  try {
    const report = await engine.tick();
    if (report.evaluated > 0 || report.errors.length > 0) {
      console.log(JSON.stringify({ at: new Date().toISOString(), ...report }));
    }
  } catch (error) {
    console.error(JSON.stringify({ at: new Date().toISOString(), fatal: (error as Error).message }));
  } finally {
    running = false;
  }
}, env.workerIntervalMs);

console.log(`Vigil worker started; ticking every ${env.workerIntervalMs}ms`);
