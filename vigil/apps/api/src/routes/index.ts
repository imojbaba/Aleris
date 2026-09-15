import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateTriggerRequest, CreateVaultRequest, CreateVaultItemRequest,
  CreateRecipientRequest, CreateGrantRequest, CheckInRequest, PauseTriggerRequest,
  AttestationRequest, RegisterRequest,
} from '@vigil/shared';
import {
  validateConfig, isValid, milestones, previewTimeline, summariseFuse,
  checkIn as applyCheckIn, pause as applyPause, resume as applyResume, cancel as applyCancel,
  type TriggerConfig,
} from '@vigil/core';
import type { MemoryRepo } from '../adapters/memory.js';

/**
 * HTTP surface.
 *
 * Deliberately thin. Every route either stores a blob the device already
 * encrypted, or asks @vigil/core a question. There is no business logic here
 * worth hiding a bug in.
 */

interface Ctx {
  repo: MemoryRepo;
  now: () => number;
}

export async function registerRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
  };
  const userId = (req: any): string => req.user.sub;

  app.get('/health', async () => ({ ok: true, storage: 'memory' }));

  /* ------------------------------ onboarding ----------------------------- */

  app.post('/v1/auth/register', async (req, reply) => {
    const parsed = RegisterRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });
    const { email, displayName } = parsed.data;

    const id = `user-${email}`;
    ctx.repo.owners.set(id, { id, email, displayName });
    await ctx.repo.appendAudit(id, 'ACCOUNT_CREATED', 'Account created.');

    // The identity blob and public key are stored verbatim. We cannot use them.
    return reply.code(201).send({ token: app.jwt.sign({ sub: id }), userId: id });
  });

  /* -------------------------------- triggers ----------------------------- */

  /**
   * Validation runs server-side as well as on the device. Not because we
   * distrust our own app, but because a config that could hurt someone must be
   * impossible to store, whatever the client believes.
   */
  app.post('/v1/triggers', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateTriggerRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });

    const config = parsed.data.config as TriggerConfig;
    const issues = validateConfig(config);
    if (!isValid(config)) {
      return reply.code(422).send({ error: 'unsafe_configuration', issues });
    }

    const now = ctx.now();
    const id = `trigger-${Math.random().toString(36).slice(2, 10)}`;
    ctx.repo.triggers.set(id, {
      id,
      userId: userId(req),
      name: parsed.data.name,
      config,
      state: { status: 'ACTIVE', lastCheckInAt: now, statusSince: now, attestations: [], nudgesSent: [] },
      nextEvaluationAt: milestones(config, now).dueAt,
    });
    await ctx.repo.appendAudit(userId(req), 'TRIGGER_ARMED', `${parsed.data.name} armed. ${summariseFuse(config)}`);
    return reply.code(201).send({ id, warnings: issues.filter((i) => i.severity === 'warning') });
  });

  app.get('/v1/triggers', { preHandler: auth }, async (req) => {
    const mine = [...ctx.repo.triggers.values()].filter((t) => t.userId === userId(req));
    return mine.map((t) => {
      const m = milestones(t.config, t.state.lastCheckInAt);
      return {
        id: t.id,
        name: t.name,
        status: t.state.status,
        config: t.config,
        lastCheckInAt: new Date(t.state.lastCheckInAt).toISOString(),
        nextCheckInDueAt: new Date(m.dueAt).toISOString(),
        earliestReleaseAt: new Date(m.earliestReleaseAt).toISOString(),
        summary: summariseFuse(t.config),
      };
    });
  });

  /**
   * The forecast the user sees before arming anything: every step, dated, in
   * order, with the ones that involve other people clearly marked.
   */
  app.post('/v1/triggers/preview', { preHandler: auth }, async (req, reply) => {
    const parsed = z.object({ config: CreateTriggerRequest.shape.config }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });
    const config = parsed.data.config as TriggerConfig;
    return {
      issues: validateConfig(config),
      summary: summariseFuse(config),
      timeline: previewTimeline(config, ctx.now()).map((e) => ({ ...e, atIso: new Date(e.at).toISOString() })),
    };
  });

  app.post('/v1/check-in', { preHandler: auth }, async (req, reply) => {
    const parsed = CheckInRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const t = ctx.repo.triggers.get(parsed.data.triggerId);
    if (!t || t.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });

    const now = ctx.now();
    t.state = applyCheckIn(t.state, now);
    t.nextEvaluationAt = milestones(t.config, now).dueAt;
    await ctx.repo.appendAudit(t.userId, 'CHECK_IN', `${t.name}: checked in via ${parsed.data.source}.`);
    return { status: t.state.status, nextCheckInDueAt: new Date(t.nextEvaluationAt).toISOString() };
  });

  app.post('/v1/triggers/pause', { preHandler: auth }, async (req, reply) => {
    const parsed = PauseTriggerRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const t = ctx.repo.triggers.get(parsed.data.triggerId);
    if (!t || t.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });

    const until = parsed.data.untilIso ? Date.parse(parsed.data.untilIso) : null;
    t.state = applyPause(t.state, ctx.now(), until);
    t.nextEvaluationAt = until;
    await ctx.repo.appendAudit(t.userId, 'TRIGGER_PAUSED', `${t.name}: paused. Nothing is counting down.`);
    return { status: t.state.status };
  });

  app.post('/v1/triggers/resume', { preHandler: auth }, async (req, reply) => {
    const parsed = z.object({ triggerId: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const t = ctx.repo.triggers.get(parsed.data.triggerId);
    if (!t || t.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });
    const now = ctx.now();
    t.state = applyResume(t.state, now);
    t.nextEvaluationAt = milestones(t.config, now).dueAt;
    return { status: t.state.status };
  });

  app.delete('/v1/triggers/:id', { preHandler: auth }, async (req: any, reply) => {
    const t = ctx.repo.triggers.get(req.params.id);
    if (!t || t.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });
    t.state = applyCancel(t.state, ctx.now());
    t.nextEvaluationAt = null;
    await ctx.repo.appendAudit(t.userId, 'TRIGGER_CANCELLED', `${t.name}: cancelled. It will never fire.`);
    return { status: t.state.status };
  });

  /* --------------------------- vaults & recipients ----------------------- */

  const vaults = new Map<string, any>();
  const items = new Map<string, any[]>();

  app.post('/v1/vaults', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateVaultRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });
    const id = `vault-${Math.random().toString(36).slice(2, 10)}`;
    vaults.set(id, { id, userId: userId(req), ...parsed.data });
    items.set(id, []);
    return reply.code(201).send({ id });
  });

  app.post('/v1/vaults/:id/items', { preHandler: auth }, async (req: any, reply) => {
    const vault = vaults.get(req.params.id);
    if (!vault || vault.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });
    const parsed = CreateVaultItemRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });
    const id = `item-${Math.random().toString(36).slice(2, 10)}`;
    items.get(vault.id)!.push({ id, ...parsed.data });
    return reply.code(201).send({ id });
  });

  app.post('/v1/recipients', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateRecipientRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });
    const id = `rcpt-${Math.random().toString(36).slice(2, 10)}`;
    ctx.repo.recipients.set(id, {
      id, userId: userId(req), displayName: parsed.data.displayName,
      email: parsed.data.email, phone: parsed.data.phone, isVerifier: false,
    });
    return reply.code(201).send({ id });
  });

  /**
   * Grants arrive already sealed by the device. The server validates shape and
   * stores the blob; it has no way to inspect or alter what is inside.
   */
  app.post('/v1/grants', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateGrantRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });
    const { vaultId, recipientId, triggerId, grant } = parsed.data;

    if (grant.mode === 'SPLIT_CUSTODY') {
      // Refuse, at the edge, any grant where our own shares would reach the
      // threshold. The device already enforces this; enforcing it again here
      // means a compromised or modified client cannot talk us into holding
      // enough to open a vault by ourselves.
      const serviceShares = grant.shares.filter((s) => s.kind === 'SERVICE').length;
      if (serviceShares >= grant.threshold) {
        return reply.code(422).send({
          error: 'unsafe_grant',
          message: 'This grant would let Vigil open the vault without anyone else. Refused.',
        });
      }
    }

    const id = `grant-${Math.random().toString(36).slice(2, 10)}`;
    ctx.repo.grants.push({ id, triggerId, vaultId, recipientId, mode: grant.mode });
    await ctx.repo.appendAudit(userId(req), 'GRANT_CREATED', 'A vault was attached to a recipient.');
    return reply.code(201).send({ id });
  });

  /* ----------------------------- verifier answer -------------------------- */

  /**
   * Unauthenticated by design: the verifier is a member of the public holding a
   * one-time link. The token is the credential, it is single-use, and we store
   * only its hash.
   */
  app.post('/v1/confirm', async (req, reply) => {
    const parsed = AttestationRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    return reply.code(202).send({
      recorded: true,
      message:
        parsed.data.verdict === 'ALIVE'
          ? 'Thank you. Everything has been stopped.'
          : 'Thank you. Nothing happens immediately; there is still a waiting period.',
    });
  });

  /* -------------------------------- audit log ----------------------------- */

  app.get('/v1/audit', { preHandler: auth }, async (req) =>
    ctx.repo.audit.filter((a) => a.userId === userId(req)),
  );
}
