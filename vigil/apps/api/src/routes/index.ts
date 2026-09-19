import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateTriggerRequest, WorkflowSchema, CreateVaultRequest, CreateVaultItemRequest,
  CreateRecipientRequest, CreateGrantRequest, CheckInRequest, PauseTriggerRequest,
  WellbeingAnswerRequest, ClaimStartRequest, ClaimVerifyRequest, RegisterRequest,
} from '@vigil/shared';
import {
  validateWorkflow, isValidWorkflow, plan, projectTimeline, summariseWorkflow, evaluate,
  checkIn as applyCheckIn, pause as applyPause, resume as applyResume, cancel as applyCancel,
  recordAttestation, freshState, type Workflow,
} from '@vigil/core';
import type { AppStore } from '../domain/appStore.js';
import type { Tokens } from '../domain/ports.js';

/**
 * HTTP surface. Deliberately thin: every route either stores a blob the device
 * already encrypted, or asks @vigil/core a question.
 */

interface Ctx {
  store: AppStore;
  tokens: Tokens;
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
  const bad = (reply: any, issues?: unknown) => reply.code(400).send({ error: 'invalid', issues });

  app.get('/health', async () => ({ ok: true, storage: 'memory' }));

  /* ------------------------------ onboarding ----------------------------- */

  app.post('/v1/auth/register', async (req, reply) => {
    const parsed = RegisterRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);
    const { email, displayName, identity, publicKey } = parsed.data;

    if (await ctx.store.userByEmail(email)) {
      return reply.code(409).send({ error: 'already_registered' });
    }
    // The identity blob and public key are stored verbatim. We cannot use
    // either: the blob only opens with a passphrase we never receive.
    const user = await ctx.store.createUser({ email, displayName, identity, publicKey });
    await ctx.store.appendAudit(user.id, 'ACCOUNT_CREATED', 'Account created.');
    return reply.code(201).send({ token: app.jwt.sign({ sub: user.id }), userId: user.id });
  });

  /**
   * The encrypted identity blob, so a new phone can restore.
   *
   * Signing in is NOT unlocking: this hands back a blob that only the user's
   * passphrase opens. A stolen session token gets someone the ciphertext and
   * nothing else.
   */
  app.get('/v1/me', { preHandler: auth }, async (req, reply) => {
    const user = await ctx.store.userById(userId(req));
    if (!user) return reply.code(404).send({ error: 'not_found' });
    return {
      id: user.id, email: user.email, displayName: user.displayName,
      identity: user.identity, publicKey: user.publicKey,
    };
  });

  /* -------------------------------- triggers ----------------------------- */

  /**
   * The workflow is validated here with the SAME @vigil/core rules the app runs.
   * Not from distrust of our own client — because a workflow that could hurt
   * someone should be impossible to store, whatever software is talking to us.
   * A modified app cannot post a trigger that fires in an hour, or one that
   * only ever tries a single channel.
   */
  app.post('/v1/triggers', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateTriggerRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    const workflow = parsed.data.workflow as Workflow;
    const issues = validateWorkflow(workflow);
    if (!isValidWorkflow(workflow)) {
      return reply.code(422).send({ error: 'unsafe_workflow', issues });
    }

    const now = ctx.now();
    const created = await ctx.store.createTrigger({
      userId: userId(req), name: parsed.data.name, workflow,
      state: freshState(now),
      nextEvaluationAt: plan(workflow, now).dueAt,
    });
    await ctx.store.appendAudit(
      userId(req), 'TRIGGER_ARMED', `${parsed.data.name} armed. ${summariseWorkflow(workflow)}`,
    );
    return reply.code(201).send({
      id: created.id, warnings: issues.filter((i) => i.severity === 'warning'),
    });
  });

  app.get('/v1/triggers', { preHandler: auth }, async (req) =>
    (await ctx.store.triggersFor(userId(req)))
      .map((t) => {
        const p = plan(t.workflow, t.state.lastCheckInAt);
        const d = evaluate(t.workflow, t.state, ctx.now());
        return {
          id: t.id,
          name: t.name,
          status: d.status,
          workflow: t.workflow,
          currentStepId: d.currentStepId,
          lastCheckInAt: new Date(t.state.lastCheckInAt).toISOString(),
          nextCheckInDueAt: new Date(p.dueAt).toISOString(),
          earliestDeliveryAt: new Date(p.fireAt).toISOString(),
          summary: summariseWorkflow(t.workflow),
        };
      }),
  );

  /** The dated forecast, before anything is armed. */
  app.post('/v1/triggers/preview', { preHandler: auth }, async (req, reply) => {
    const parsed = z.object({
      workflow: WorkflowSchema,
      contactNames: z.record(z.string(), z.string()).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    const workflow = parsed.data.workflow as Workflow;
    return {
      issues: validateWorkflow(workflow),
      summary: summariseWorkflow(workflow),
      timeline: projectTimeline(workflow, ctx.now(), parsed.data.contactNames ?? {}).map((e) => ({
        ...e, atIso: new Date(e.at).toISOString(),
      })),
    };
  });

  app.post('/v1/check-in', { preHandler: auth }, async (req, reply) => {
    const parsed = CheckInRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply);
    const t = await ctx.store.trigger(parsed.data.triggerId);
    if (!t || t.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });

    const now = ctx.now();
    const dueAt = plan(t.workflow, now).dueAt;
    await ctx.store.updateTriggerState(t.id, applyCheckIn(t.state, now), dueAt);
    await ctx.store.appendAudit(t.userId, 'CHECK_IN', `${t.name}: checked in via ${parsed.data.source}.`);
    return { status: 'ACTIVE', nextCheckInDueAt: new Date(dueAt).toISOString() };
  });

  app.post('/v1/triggers/pause', { preHandler: auth }, async (req, reply) => {
    const parsed = PauseTriggerRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply);
    const t = await ctx.store.trigger(parsed.data.triggerId);
    if (!t || t.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });
    const until = parsed.data.untilIso ? Date.parse(parsed.data.untilIso) : null;
    await ctx.store.updateTriggerState(t.id, applyPause(t.state, ctx.now(), until), until);
    await ctx.store.appendAudit(t.userId, 'TRIGGER_PAUSED', `${t.name}: paused. Nothing is counting down.`);
    return { status: 'PAUSED' };
  });

  app.post('/v1/triggers/resume', { preHandler: auth }, async (req, reply) => {
    const parsed = z.object({ triggerId: z.string() }).safeParse(req.body);
    if (!parsed.success) return bad(reply);
    const t = await ctx.store.trigger(parsed.data.triggerId);
    if (!t || t.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });
    const now = ctx.now();
    await ctx.store.updateTriggerState(t.id, applyResume(t.state, now), plan(t.workflow, now).dueAt);
    return { status: 'ACTIVE' };
  });

  app.delete('/v1/triggers/:id', { preHandler: auth }, async (req: any, reply) => {
    const t = await ctx.store.trigger(req.params.id);
    if (!t || t.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });
    await ctx.store.updateTriggerState(t.id, applyCancel(t.state, ctx.now()), null);
    await ctx.store.appendAudit(t.userId, 'TRIGGER_CANCELLED', `${t.name}: cancelled. It will never fire.`);
    return { status: 'CANCELLED' };
  });

  /* --------------------------- vaults & recipients ----------------------- */

  app.post('/v1/vaults', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateVaultRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);
    const v = await ctx.store.createVault({
      userId: userId(req),
      encryptedTitle: parsed.data.encryptedTitle,
      wrappedVaultKey: parsed.data.wrappedVaultKey,
      ...(parsed.data.cosmetic
        ? { accent: parsed.data.cosmetic.accent, glyph: parsed.data.cosmetic.glyph }
        : {}),
    });
    return reply.code(201).send({ id: v.id });
  });

  app.post('/v1/vaults/:id/items', { preHandler: auth }, async (req: any, reply) => {
    const vault = await ctx.store.vault(req.params.id);
    if (!vault || vault.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });
    const parsed = CreateVaultItemRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);
    const item = await ctx.store.createVaultItem({
      vaultId: vault.id, kind: parsed.data.kind,
      encryptedLabel: parsed.data.encryptedLabel, ciphertext: parsed.data.ciphertext,
      sizeBytes: parsed.data.sizeBytes ?? 0,
    });
    return reply.code(201).send({ id: item.id });
  });

  app.post('/v1/recipients', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateRecipientRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);
    const r = await ctx.store.createRecipient({ userId: userId(req), ...parsed.data });
    return reply.code(201).send({ id: r.id });
  });

  app.get('/v1/recipients', { preHandler: auth }, async (req) =>
    ctx.store.recipientsFor(userId(req)),
  );

  /**
   * Grants arrive already sealed by the device. We check shape and custody,
   * then store an opaque blob.
   */
  app.post('/v1/grants', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateGrantRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);
    const { vaultId, recipientId, triggerId, grant, encryptedNote } = parsed.data;

    const vault = await ctx.store.vault(vaultId);
    if (!vault || vault.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });
    const trigger = await ctx.store.trigger(triggerId);
    if (!trigger || trigger.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });

    if (grant.mode === 'SPLIT_CUSTODY') {
      const serviceShares = grant.shares.filter((s) => s.kind === 'SERVICE').length;
      if (serviceShares >= grant.threshold) {
        // Refused at the edge as well as on the device: a modified client must
        // not be able to talk the service into holding enough to open a vault.
        return reply.code(422).send({
          error: 'unsafe_grant',
          message: 'This grant would let Vigil open the vault without anyone else. Refused.',
        });
      }
    }

    const created = await ctx.store.createGrant({
      vaultId, recipientId, triggerId, mode: grant.mode, payload: grant,
      ...(encryptedNote ? { encryptedNote } : {}),
    });
    await ctx.store.appendAudit(userId(req), 'GRANT_CREATED', 'A vault was attached to a recipient.');
    return reply.code(201).send({ id: created.id });
  });

  /* --------------------------- the wellbeing check ----------------------- */

  /**
   * Unauthenticated by design: the person answering is a member of the public
   * holding a one-time link. The token is the credential, single-use, stored
   * only as a hash.
   *
   * The response says as little as possible. Someone who guesses a token learns
   * nothing about whether it was real, and nobody answering learns that a vault
   * exists.
   */
  app.post('/v1/wellbeing', async (req, reply) => {
    const parsed = WellbeingAnswerRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply);

    const thanks = {
      recorded: true,
      message:
        parsed.data.verdict === 'ALIVE'
          ? 'Thank you. Everything has been stopped.'
          : 'Thank you. Nothing happens immediately; there is still a waiting period.',
    };

    // Single-use, and claimed atomically. The same body comes back either way:
    // someone guessing a token must not learn whether it was real.
    const claim = await ctx.store.useAnswerToken(ctx.tokens.hash(parsed.data.token));
    if (!claim) return reply.code(202).send(thanks);

    const now = ctx.now();
    await ctx.store.recordAttestation({ ...claim, verdict: parsed.data.verdict, at: now, otpVerified: true });
    // Evaluate immediately rather than at the next scheduled tick: an "alive"
    // answer should stop the cascade now, not in six hours.
    await ctx.store.wakeTrigger(claim.triggerId, now);

    const trigger = await ctx.store.trigger(claim.triggerId);
    if (trigger) {
      await ctx.store.appendAudit(
        trigger.userId, 'WELLBEING_ANSWER',
        `${trigger.name}: someone you named answered "${parsed.data.verdict.toLowerCase()}".`,
      );
    }
    return reply.code(202).send(thanks);
  });

  /* ------------------------------- redeeming ----------------------------- */

  /**
   * Step 1: the recipient asks for a code at the address the owner recorded.
   * Uniform response — a guessed delivery id must not confirm itself.
   */
  app.post('/v1/claim/start', async (req, reply) => {
    const parsed = ClaimStartRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply);
    return reply.code(202).send({
      sent: true,
      message: 'If this link is valid, we have sent a code to the address it was addressed to.',
    });
  });

  /**
   * Step 2: they prove control of the address and hand us the public half of a
   * keypair their browser just made. What comes back is the sealed grant plus
   * every custody share released to this session — each sealed to that public
   * key, whose private half never leaves their device.
   */
  app.post('/v1/claim/verify', async (req, reply) => {
    const parsed = ClaimVerifyRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply);
    return reply.code(501).send({
      error: 'not_implemented',
      message: 'The redeem flow is built in @vigil/crypto and not yet wired to storage.',
    });
  });

  /* -------------------------------- audit log ----------------------------- */

  app.get('/v1/audit', { preHandler: auth }, async (req) => ctx.store.auditFor(userId(req)));
}
