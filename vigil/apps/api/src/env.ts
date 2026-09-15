/**
 * Configuration. Fails loudly at boot rather than at 3am on a release path.
 */
function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`missing required environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export const env = {
  isProd,
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  appBaseUrl: required('APP_BASE_URL', 'http://localhost:8080'),
  /**
   * In production this must be a real secret from a secret manager. The dev
   * fallback is deliberately obvious rather than a plausible-looking default
   * that could survive into a deployment unnoticed.
   */
  jwtSecret: required('JWT_SECRET', isProd ? undefined : 'dev-only-insecure-secret-do-not-ship'),
  databaseUrl: process.env.DATABASE_URL ?? '',
  /** With no DATABASE_URL we run entirely in memory, for local work and demos. */
  get storage(): 'postgres' | 'memory' {
    return this.databaseUrl ? 'postgres' : 'memory';
  },
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 60_000),
};
