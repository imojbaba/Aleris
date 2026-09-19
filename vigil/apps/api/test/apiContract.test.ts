import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { PrismaClient } from '@prisma/client';
import { VigilClient, ApiError, type StoredIdentity } from '@vigil/shared';
import { STEADY, withContacts } from '@vigil/core';
import { registerRoutes } from '../src/routes/index.js';
import { MemoryStore } from '../src/adapters/memoryStore.js';
import { PrismaStore } from '../src/adapters/prismaStore.js';
import { nodeTokens } from '../src/adapters/memory.js';
import type { AppStore } from '../src/domain/appStore.js';

/**
 * The app's client against the real routes.
 *
 * Run twice — once on the in-memory store, once on Postgres — because "the
 * adapters agree" is a claim, and the only honest way to make it is to put the
 * same expectations to both. Typechecking proves the client and server share
 * types; it says nothing about status codes, field names or error shapes,
 * which is where clients and servers actually disagree.
 */

const identity: StoredIdentity = {
  v: 1, kdf: 'argon2id', kdfSalt: 'c2FsdHNhbHQ',
  kdfParams: { m: 19456, t: 2, p: 1 }, wrappedMasterKey: 'd3JhcHBlZA',
};

/** Drives Fastify in-process, so the client exercises the real router. */
function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: String(url),
      headers: init?.headers as Record<string, string>,
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    return new Response(res.body, { status: res.statusCode });
  }) as typeof fetch;
}

async function buildApp(store: AppStore) {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  await registerRoutes(app, { store, tokens: nodeTokens, now: () => Date.now() });
  await app.ready();
  return app;
}

const url = process.env.DATABASE_URL;

const cases: { name: string; make: () => Promise<{ store: AppStore; reset: () => Promise<void> }> }[] = [
  {
    name: 'in memory',
    make: async () => {
      let store = new MemoryStore();
      return { get store() { return store; }, reset: async () => { store = new MemoryStore(); } } as never;
    },
  },
];

describe.each(
  url
    ? ['memory', 'postgres']
    : ['memory'],
)('the client against the real routes (%s)', (backend) => {
  let app: FastifyInstance;
  let client: VigilClient;
  let db: PrismaClient | null = null;

  beforeAll(async () => {
    if (backend === 'postgres') {
      db = new PrismaClient({ datasources: { db: { url } } });
      await db.$connect();
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await app?.close();
    if (db) await db.user.deleteMany({});
    const store: AppStore = db ? new PrismaStore(db) : new MemoryStore();
    app = await buildApp(store);
    client = new VigilClient({ baseUrl: '', fetchImpl: injectFetch(app) });
  });

  const register = () =>
    client.register({
      email: `jo+${Math.random().toString(36).slice(2, 8)}@example.com`,
      displayName: 'Jo', identity, publicKey: 'cHVibGlja2V5',
    });

  it('registers, and hands back a session token', async () => {
    const r = await register();
    expect(r.userId).toBeTruthy();
    expect(client.authenticated).toBe(true);
  });

  it('round-trips the encrypted identity for a new device', async () => {
    await register();
    const me = await client.me();
    // Signing in is not unlocking: this blob needs a passphrase we never see.
    expect(me.identity.wrappedMasterKey).toBe(identity.wrappedMasterKey);
    expect(me.identity.kdfParams.m).toBe(19456);
    expect(JSON.stringify(me)).not.toContain('passphrase');
  });

  it('refuses to be used without a token', async () => {
    const anon = new VigilClient({ baseUrl: '', fetchImpl: injectFetch(app) });
    await expect(anon.triggers()).rejects.toThrow(ApiError);
    await expect(anon.triggers()).rejects.toMatchObject({ status: 401 });
  });

  it('drops a token the server has stopped honouring', async () => {
    const stale = new VigilClient({ baseUrl: '', fetchImpl: injectFetch(app), token: 'nonsense' });
    await expect(stale.triggers()).rejects.toMatchObject({ status: 401 });
    expect(stale.authenticated).toBe(false);
  });

  it('previews a workflow as a dated cascade', async () => {
    await register();
    const { id } = await client.createRecipient({ displayName: 'Ray', email: 'ray@example.com' });
    const preview = await client.previewWorkflow(withContacts(STEADY, [id]) as never, { [id]: 'Ray' });
    expect(preview.summary).toMatch(/silence before anything is sent/);
    expect(preview.timeline.at(-1)!.kind).toBe('DELIVER');
    expect(preview.timeline.some((e) => e.involvesOthers)).toBe(true);
  });

  /**
   * The server validates with the same @vigil/core rules the app runs — not
   * from distrust of our own client, but so an unsafe trigger is impossible to
   * STORE whatever software is talking to us.
   */
  it('refuses a workflow that only ever tries one phone number', async () => {
    await register();
    const err = await client.createTrigger({
      name: 'risky',
      workflow: {
        checkInEveryDays: 30,
        steps: [
          { id: 'a', kind: 'REMIND_OWNER', channels: ['SMS'], times: 3, everyHours: 24 },
          { id: 'b', kind: 'REMIND_OWNER', channels: ['WHATSAPP'], times: 2, everyHours: 24 },
          { id: 'w', kind: 'WAIT', hours: 48 },
          { id: 'f', kind: 'FIRE' },
        ],
      },
    }).catch((e) => e as ApiError);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).isSafetyRefusal).toBe(true);
    // The messages are written to be read by the person, so the app shows them.
    expect(JSON.stringify((err as ApiError).issues)).toMatch(/lost SIM/);
  });

  it('arms a valid trigger, lists it, and reports when it is due', async () => {
    await register();
    const { id: rayId } = await client.createRecipient({ displayName: 'Ray', email: 'ray@example.com' });
    const created = await client.createTrigger({
      name: 'If I go quiet', workflow: withContacts(STEADY, [rayId]) as never,
    });
    expect(created.id).toBeTruthy();

    const list = await client.triggers();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('If I go quiet');
    expect(list[0]!.status).toBe('ACTIVE');
    expect(new Date(list[0]!.nextCheckInDueAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(list[0]!.earliestDeliveryAt).getTime())
      .toBeGreaterThan(new Date(list[0]!.nextCheckInDueAt).getTime());
  });

  it('checks in, pauses, resumes and cancels', async () => {
    await register();
    const { id: rayId } = await client.createRecipient({ displayName: 'Ray', email: 'ray@example.com' });
    const { id } = await client.createTrigger({
      name: 'T', workflow: withContacts(STEADY, [rayId]) as never,
    });

    expect((await client.checkIn(id)).status).toBe('ACTIVE');
    expect((await client.pause(id)).status).toBe('PAUSED');
    expect((await client.resume(id)).status).toBe('ACTIVE');
    expect((await client.cancel(id)).status).toBe('CANCELLED');
    expect((await client.triggers())[0]!.status).toBe('CANCELLED');
  });

  it('stores a vault and an item as ciphertext only', async () => {
    await register();
    const vault = await client.createVault({ encryptedTitle: 'Y2lwaGVy', wrappedVaultKey: 'd3JhcA' });
    const item = await client.createVaultItem(vault.id, {
      kind: 'LETTER', encryptedLabel: 'bGFiZWw', ciphertext: 'Ym9keQ', sizeBytes: 42,
    });
    expect(item.id).toBeTruthy();
  });

  it('refuses a grant that would let Vigil open the vault alone', async () => {
    await register();
    const vault = await client.createVault({ encryptedTitle: 'Y2lwaGVy', wrappedVaultKey: 'd3JhcA' });
    const { id: rayId } = await client.createRecipient({ displayName: 'Ray', email: 'ray@example.com' });
    const { id: triggerId } = await client.createTrigger({
      name: 'T', workflow: withContacts(STEADY, [rayId]) as never,
    });

    const err = await client.createGrant({
      vaultId: vault.id, recipientId: rayId, triggerId,
      grant: {
        v: 1, mode: 'SPLIT_CUSTODY', grantId: 'g1', threshold: 2, wrappedVaultKey: 'd3JhcA',
        shares: [
          { custodianId: 's1', kind: 'SERVICE', index: 1, protection: 'PUBLIC_KEY', sealed: 'YQ' },
          { custodianId: 's2', kind: 'SERVICE', index: 2, protection: 'PUBLIC_KEY', sealed: 'Yg' },
        ],
      },
    }).catch((e) => e as ApiError);

    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).isSafetyRefusal).toBe(true);
  });

  it('accepts a properly split grant', async () => {
    await register();
    const vault = await client.createVault({ encryptedTitle: 'Y2lwaGVy', wrappedVaultKey: 'd3JhcA' });
    const { id: rayId } = await client.createRecipient({ displayName: 'Ray', email: 'ray@example.com' });
    const { id: triggerId } = await client.createTrigger({
      name: 'T', workflow: withContacts(STEADY, [rayId]) as never,
    });
    const grant = await client.createGrant({
      vaultId: vault.id, recipientId: rayId, triggerId,
      grant: {
        v: 1, mode: 'SPLIT_CUSTODY', grantId: 'g1', threshold: 2, wrappedVaultKey: 'd3JhcA',
        shares: [
          { custodianId: 'svc', kind: 'SERVICE', index: 1, protection: 'PUBLIC_KEY', sealed: 'YQ' },
          { custodianId: 'ray', kind: 'VERIFIER', index: 2, protection: 'CLAIM_CODE', sealed: 'Yg' },
        ],
      },
    });
    expect(grant.id).toBeTruthy();
  });

  it('answers a wellbeing check identically whether the token is real', async () => {
    // A member of the public guessing a token must not learn whether it hit.
    const a = await client.answerWellbeing({ token: 'x'.repeat(24), verdict: 'ALIVE' });
    const b = await client.answerWellbeing({ token: 'y'.repeat(24), verdict: 'ALIVE' });
    expect(a).toEqual(b);
    expect(a.message).toMatch(/stopped/);
  });

  it('gives the owner a readable audit trail', async () => {
    await register();
    const { id: rayId } = await client.createRecipient({ displayName: 'Ray', email: 'ray@example.com' });
    await client.createTrigger({ name: 'T', workflow: withContacts(STEADY, [rayId]) as never });
    const audit = await client.audit();
    expect(audit.map((a) => a.kind)).toContain('ACCOUNT_CREATED');
    expect(audit.map((a) => a.kind)).toContain('TRIGGER_ARMED');
  });
});
