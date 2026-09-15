import { evaluate, applyDecision, type Action, type Decision } from '@vigil/core';
import type {
  Clock, Locks, Notifier, OutboundMessage, TriggerRecord, TriggerRepository, Tokens,
} from './ports.js';

/**
 * The worker's brain.
 *
 * @vigil/core decides WHAT should happen; this decides how it is carried out and
 * makes sure it happens exactly once. The division matters: the decision is pure
 * and exhaustively tested, and everything irreversible is funnelled through
 * `release()` below, which is the only function in Vigil that can send a
 * person's private life to someone else.
 */

export interface TickReport {
  evaluated: number;
  released: number;
  messagesSent: number;
  skippedLocked: number;
  errors: { triggerId: string; error: string }[];
}

export interface EngineDeps {
  repo: TriggerRepository;
  notifier: Notifier;
  clock: Clock;
  locks: Locks;
  tokens: Tokens;
  /** Base URL used to build links in outbound messages. */
  appBaseUrl: string;
}

export class ReleaseEngine {
  constructor(private readonly deps: EngineDeps) {}

  async tick(limit = 100): Promise<TickReport> {
    const now = this.deps.clock.now();
    const due = await this.deps.repo.dueTriggers(now, limit);
    const report: TickReport = { evaluated: 0, released: 0, messagesSent: 0, skippedLocked: 0, errors: [] };

    for (const trigger of due) {
      try {
        const result = await this.deps.locks.withLock(`trigger:${trigger.id}`, () =>
          this.processOne(trigger, now),
        );
        if (result === null) {
          report.skippedLocked += 1;
          continue;
        }
        report.evaluated += 1;
        report.messagesSent += result.messagesSent;
        if (result.released) report.released += 1;
      } catch (error) {
        // One poisoned trigger must not stop the sweep: every other user's
        // reminders are still owed.
        report.errors.push({ triggerId: trigger.id, error: (error as Error).message });
      }
    }
    return report;
  }

  private async processOne(trigger: TriggerRecord, now: number) {
    const decision = evaluate(trigger.config, trigger.state, now);
    let messagesSent = 0;
    let released = false;

    for (const action of decision.actions) {
      messagesSent += await this.perform(trigger, action, decision, now);
      if (action.kind === 'RELEASE') released = true;
    }

    const nextState = applyDecision(trigger.state, decision, now);
    await this.deps.repo.saveState(
      trigger.id,
      // RELEASING is a transient state; once deliveries exist the trigger is done.
      released ? { ...nextState, status: 'RELEASED', statusSince: now } : nextState,
      decision.nextEvaluationAt,
    );

    if (decision.status !== trigger.state.status) {
      await this.deps.repo.appendAudit(
        trigger.userId,
        'TRIGGER_STATUS_CHANGED',
        `${trigger.name}: ${trigger.state.status} → ${released ? 'RELEASED' : decision.status}. ${decision.reason}`,
        { from: trigger.state.status, to: decision.status, reason: decision.reason },
      );
    }

    return { messagesSent, released };
  }

  private async perform(
    trigger: TriggerRecord,
    action: Action,
    decision: Decision,
    now: number,
  ): Promise<number> {
    switch (action.kind) {
      case 'NUDGE_OWNER':
        return this.nudgeOwner(trigger, action.step, action.channels, now);
      case 'NOTIFY_OWNER_FINAL_WARNING':
        return this.nudgeOwner(trigger, -1, ['EMAIL', 'SMS', 'PUSH'], now, 'FINAL_WARNING');
      case 'ASK_VERIFIERS':
        return this.askVerifiers(trigger, action.verifierIds, now);
      case 'RELEASE':
        return this.release(trigger, now);
      case 'RECORD_STAND_DOWN':
        await this.deps.repo.appendAudit(
          trigger.userId, 'STAND_DOWN', `${trigger.name}: stood down. ${action.because}`,
        );
        return 0;
    }
  }

  private async nudgeOwner(
    trigger: TriggerRecord,
    step: number,
    channels: OutboundMessage['channel'][],
    now: number,
    template: OutboundMessage['template'] = step < 0 ? 'FINAL_WARNING' : 'ESCALATION',
  ): Promise<number> {
    const owner = await this.deps.repo.owner(trigger.userId);
    if (!owner) return 0;

    let sent = 0;
    for (const channel of channels) {
      const result = await this.deps.notifier.send({
        channel,
        to: { email: owner.email, userId: owner.id },
        template,
        variables: {
          name: owner.displayName,
          trigger: trigger.name,
          checkInUrl: `${this.deps.appBaseUrl}/check-in/${trigger.id}`,
        },
      });
      if (step >= 0) await this.deps.repo.recordNudge(trigger.id, step, channel, now);
      if (result.ok) sent += 1;
    }
    return sent;
  }

  private async askVerifiers(trigger: TriggerRecord, verifierIds: string[], now: number): Promise<number> {
    let sent = 0;
    for (const verifierId of verifierIds) {
      const verifier = await this.deps.repo.recipient(verifierId);
      if (!verifier) continue;

      // The token goes in the message; only its hash is stored. A reader of our
      // database cannot answer on a verifier's behalf.
      const { token, hash } = this.deps.tokens.mint();
      await this.deps.repo.recordAttestationToken(trigger.id, verifierId, hash);

      const owner = await this.deps.repo.owner(trigger.userId);
      const result = await this.deps.notifier.send({
        channel: verifier.email ? 'EMAIL' : 'SMS',
        to: { email: verifier.email, phone: verifier.phone },
        template: 'VERIFIER_QUESTION',
        variables: {
          verifierName: verifier.displayName,
          ownerName: owner?.displayName ?? 'someone who trusts you',
          // The verifier is asked one question and shown nothing else. They are
          // not told a vault exists, what is in it, or who else is involved.
          answerUrl: `${this.deps.appBaseUrl}/confirm/${token}`,
        },
      });
      if (result.ok) sent += 1;
    }
    if (sent > 0) {
      await this.deps.repo.appendAudit(
        trigger.userId, 'VERIFIERS_ASKED',
        `${trigger.name}: asked ${sent} ${sent === 1 ? 'person' : 'people'} to confirm you are alright.`,
      );
    }
    return sent;
  }

  /**
   * The irreversible step.
   *
   * Two properties this must have, both enforced here rather than assumed:
   *
   *  1. EXACTLY ONCE. A worker that crashes mid-release and retries must not
   *     send anything twice. We check existing deliveries per grant first.
   *  2. NO KEY MATERIAL PASSES THROUGH THIS FUNCTION. The server does not
   *     reconstruct anything. It sends the recipient a claim link; the
   *     recipient's own device gathers the custody shares — ours plus the
   *     verifiers' — and reassembles the vault key locally. At no instant does
   *     any single machine we control hold enough to open the vault.
   */
  private async release(trigger: TriggerRecord, now: number): Promise<number> {
    const [grants, existing] = await Promise.all([
      this.deps.repo.grantsFor(trigger.id),
      this.deps.repo.deliveriesFor(trigger.id),
    ]);
    const alreadyDelivered = new Set(existing.map((d) => d.grantId));

    let sent = 0;
    for (const grant of grants) {
      if (alreadyDelivered.has(grant.id)) continue;

      const recipient = await this.deps.repo.recipient(grant.recipientId);
      if (!recipient) continue;

      const { token, hash } = this.deps.tokens.mint();
      const delivery = await this.deps.repo.createDelivery({
        id: `${trigger.id}:${grant.id}`,
        triggerId: trigger.id,
        grantId: grant.id,
        recipientId: grant.recipientId,
        claimTokenHash: hash,
      });

      const owner = await this.deps.repo.owner(trigger.userId);
      const result = await this.deps.notifier.send({
        channel: recipient.email ? 'EMAIL' : 'SMS',
        to: { email: recipient.email, phone: recipient.phone },
        template: 'DELIVERY',
        variables: {
          recipientName: recipient.displayName,
          ownerName: owner?.displayName ?? 'someone',
          claimUrl: `${this.deps.appBaseUrl}/for-you/${delivery.id}?k=${token}`,
        },
      });

      if (result.ok) {
        await this.deps.repo.markDeliveryDispatched(delivery.id, now);
        sent += 1;
      }
    }

    await this.deps.repo.appendAudit(
      trigger.userId, 'RELEASED',
      `${trigger.name}: released to ${sent} ${sent === 1 ? 'person' : 'people'}.`,
      { grants: grants.length, dispatched: sent },
    );
    return sent;
  }
}
