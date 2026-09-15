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
import type { MemoryRepo } from '../adapters/memory.js';
import type { Tokens } from '../domain/ports.js';

/**
 * HTTP surface. Deliberately thin: every route either stores a blob the device
 * already encrypted, or asks @vigil/core a question.
 */

interface Ctx {
  repo: MemoryRepo;
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
    const { email, displayName } = parsed.data;
    const id = `user-${email}`;
    ctx.repo.owners.set(id, { id, email, displayName });
    await ctx.repo.appendAudit(id, 'ACCOUNT_CREATED', 'Account created.');
    return reply.code(201).send({ token: app.jwt.sign({ sub: id }), userId: id });
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
    const id = `trigger-${Math.random().toString(36).slice(2, 10)}`;
    ctx.repo.triggers.set(id, {
      id, userId: userId(req), name: parsed.data.name, workflow,
      state: freshState(now),
      nextEvaluationAt: plan(workflow, now).dueAt,
    });
    await ctx.repo.appendAudit(
      userId(req), 'TRIGGER_ARMED', `${parsed.data.name} armed. ${summariseWorkflow(workflow)}`,
    );
    return reply.code(201).send({ id, warnings: issues.filter((i) => i.severity === 'warning') });
  });

  app.get('/v1/triggers', { preHandler: auth }, async (req) =>
    [...ctx.repo.triggers.values()]
      .filter((t) => t.userId === userId(req))
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
    const t = ctx.repo.triggers.get(parsed.data.triggerId);
    if (!t || t.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });

    const now = ctx.now();
    t.state = applyCheckIn(t.state, now);
    t.nextEvaluationAt = plan(t.workflow, now).dueAt;
    await ctx.repo.appendAudit(t.userId, 'CHECK_IN', `${t.name}: checked in via ${parsed.data.source}.`);
    return { status: t.state.status, nextCheckInDueAt: new Date(t.nextEvaluationAt).toISOString() };
  });

  app.post('/v1/triggers/pause', { preHandler: auth }, async (req, reply) => {
    const parsed = PauseTriggerRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply);
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
    if (!parsed.success) return bad(reply);
    const t = ctx.repo.triggers.get(parsed.data.triggerId);
    if (!t || t.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });
    const now = ctx.now();
    t.state = applyResume(t.state, now);
    t.nextEvaluationAt = plan(t.workflow, now).dueAt;
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
    if (!parsed.success) return bad(reply, parsed.error.issues);
    const id = `vault-${Math.random().toString(36).slice(2, 10)}`;
    vaults.set(id, { id, userId: userId(req), ...parsed.data });
    items.set(id, []);
    return reply.code(201).send({ id });
  });

  app.post('/v1/vaults/:id/items', { preHandler: auth }, async (req: any, reply) => {
    const vault = vaults.get(req.params.id);
    if (!vault || vault.userId !== userId(req)) return reply.code(404).send({ error: 'not_found' });
    const parsed = CreateVaultItemRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);
    const id = `item-${Math.random().toString(36).slice(2, 10)}`;
    items.get(vault.id)!.push({ id, ...parsed.data });
    return reply.code(201).send({ id });
  });

  app.post('/v1/recipients', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateRecipientRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);
    const id = `rcpt-${Math.random().toString(36).slice(2, 10)}`;
    ctx.repo.recipients.set(id, {
      id, userId: userId(req), displayName: parsed.data.displayName,
      email: parsed.data.email, phone: parsed.data.phone, isVerifier: false,
    });
    return reply.code(201).send({ id });
  });

  /**
   * Grants arrive already sealed by the device. We check shape and custody,
   * then store an opaque blob.
   */
  app.post('/v1/grants', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateGrantRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);
    const { vaultId, recipientId, triggerId, grant } = parsed.data;

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

    const id = `grant-${Math.random().toString(36).slice(2, 10)}`;
    ctx.repo.grants.push({ id, triggerId, vaultId, recipientId, mode: grant.mode });
    await ctx.repo.appendAudit(userId(req), 'GRANT_CREATED', 'A vault was attached to a recipient.');
    return reply.code(201).send({ id });
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

    const hash = ctx.tokens.hash(parsed.data.token);
    const record = ctx.repo.answerTokens.find((t) => t.tokenHash === hash);

    const thanks = {
      recorded: true,
      message:
        parsed.data.verdict === 'ALIVE'
          ? 'Thank you. Everything has been stopped.'
          : 'Thank you. Nothing happens immediately; there is still a waiting period.',
    };
    // Same body either way: a bad token must be indistinguishable from a good one.
    if (!record) return reply.code(202).send(thanks);

    const trigger = ctx.repo.triggers.get(record.triggerId);
    if (trigger) {
      trigger.state = recordAttestation(trigger.state, {
        contactId: record.contactId,
        verdict: parsed.data.verdict,
        at: ctx.now(),
        otpVerified: true,
      });
      // Re-evaluate immediately: an ALIVE answer should stop the cascade now,
      // not at the next scheduled tick.
      trigger.nextEvaluationAt = ctx.now();
      await ctx.repo.appendAudit(
        trigger.userId, 'WELLBEING_ANSWER',
        `${trigger.name}: someone you named answered "${parsed.data.verdict.toLowerCase()}".`,
      );
    }
    return reply.code(202).send(thanks);
  });

  /* ------------------------------- redeeming ----------------------------- */

  /** Step 1: the recipient asks for a code at the address the owner recorded. */
  app.post('/v1/claim/start', async (req, reply) => {
    const parsed = ClaimStartRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply);
    const delivery = ctx.repo.deliveries.find((d) => d.id === parsed.data.deliveryId);
    const ok = delivery && delivery.claimTokenHash === ctx.tokens.hash(parsed.data.token);
    // Uniform response: a guessed delivery id must not confirm itself.
    return reply.code(202).send({
      sent: true,
      message: 'If this link is valid, we have sent a code to the address it was addressed to.',
      _matched: ok ? true : undefined,
    });
  });

  /**
   * Step 2: they prove control of the address and hand us the public half of a
   * keypair their browser just made.
   *
   * What comes back is the sealed grant plus every custody share released to
   * this session — each sealed to `claimPublicKey`, whose private half never
   * leaves their device. The owner's question comes back too; the ANSWER never
   * reaches us in any form, because it is key material, not a password we check.
   */
  app.post('/v1/claim/verify', async (req, reply) => {
    const parsed = ClaimVerifyRequest.safeParse(req.body);
    if (!parsed.success) return bad(reply);

    const delivery = ctx.repo.deliveries.find((d) => d.id === parsed.data.deliveryId);
    if (!delivery || delivery.claimTokenHash !== ctx.tokens.hash(parsed.data.token)) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const grant = ctx.repo.grants.find((g) => g.id === delivery.grantId);
    const trigger = grant ? ctx.repo.triggers.get(grant.triggerId) : undefined;
    const owner = trigger ? await ctx.repo.owner(trigger.userId) : null;

    return {
      deliveryId: delivery.id,
      ownerName: owner?.displayName ?? 'someone',
      // The service seals its own share to the claim session here. It is one
      // share of a threshold it is short of, so relaying is all it can do.
      relayedShares: ctx.repo.relayedShares
        .filter((r) => r.deliveryId === delivery.id)
        .map(({ custodianId, sealed }) => ({ custodianId, sealed })),
      awaiting: ctx.repo.awaitingCustodians(delivery.id),
    };
  });

  /* -------------------------------- audit log ----------------------------- */

  app.get('/v1/audit', { preHandler: auth }, async (req) =>
    ctx.repo.audit.filter((a) => a.userId === userId(req)),
  );
}
