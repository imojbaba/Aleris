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
    /**
     * Heartbeat AFTER a completed tick, never before.
     *
     * A worker that dies quietly is a product that quietly stops keeping its
     * promise, and nobody outside would ever notice — the failure looks exactly
     * like everyone being fine. Pinging on entry would report health for a
     * process that then crashed; pinging on exit reports work actually done.
     */
    if (env.heartbeatUrl) {
      await fetch(env.heartbeatUrl, { method: 'POST' }).catch(() => {});
    }
  } catch (error) {
    console.error(JSON.stringify({ at: new Date().toISOString(), fatal: (error as Error).message }));
  } finally {
    running = false;
  }
}, env.workerIntervalMs);

console.log(`Vigil worker started; ticking every ${env.workerIntervalMs}ms`);
