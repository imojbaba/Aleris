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

  /**
   * Message providers. Every one is optional, and an unset channel logs
   * instead of sending.
   *
   * That default is deliberate for this product: a staging environment that
   * can really send is one bad environment variable away from telling
   * someone's mother they have died. Sending is opt-in, per channel, and the
   * boot log says which channels are live.
   */
  notifiers: {
    resendApiKey: process.env.RESEND_API_KEY,
    emailFrom: process.env.EMAIL_FROM,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    twilioSmsFrom: process.env.TWILIO_SMS_FROM,
    whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  },

  /** Heartbeat URL pinged after each worker tick. See docs/06-going-live.md. */
  heartbeatUrl: process.env.HEARTBEAT_URL,
};
