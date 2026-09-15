import { evaluate, applyDecision, type Action } from '@vigil/core';
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
    const decision = evaluate(trigger.workflow, trigger.state, now);
    let messagesSent = 0;
    let released = false;

    for (const action of decision.actions) {
      messagesSent += await this.perform(trigger, action);
      if (action.kind === 'FIRE') released = true;
    }

    // applyDecision moves the trigger to DELIVERED in the same step that records
    // the FIRE, so a second tick cannot deliver again even if this crashes here.
    await this.deps.repo.saveState(
      trigger.id,
      applyDecision(trigger.state, decision, now),
      decision.nextEvaluationAt,
    );

    if (decision.status !== trigger.state.status) {
      await this.deps.repo.appendAudit(
        trigger.userId,
        'TRIGGER_STATUS_CHANGED',
        `${trigger.name}: ${trigger.state.status} → ${decision.status}. ${decision.reason}`,
        { from: trigger.state.status, to: decision.status, reason: decision.reason, step: decision.currentStepId },
      );
    }

    return { messagesSent, released };
  }

  private async perform(trigger: TriggerRecord, action: Action): Promise<number> {
    switch (action.kind) {
      case 'REMIND_OWNER':
        return this.remindOwner(trigger, action);
      case 'WELLBEING_CHECK':
        return this.wellbeingCheck(trigger, action);
      case 'REQUEST_CONFIRMATION':
        return this.requestConfirmation(trigger, action);
      case 'FIRE':
        return this.deliver(trigger, this.deps.clock.now());
      case 'STAND_DOWN':
        await this.deps.repo.appendAudit(
          trigger.userId, 'STAND_DOWN', `${trigger.name}: stood down. ${action.because}`,
        );
        return 0;
    }
  }

  private async remindOwner(
    trigger: TriggerRecord,
    action: Extract<Action, { kind: 'REMIND_OWNER' }>,
  ): Promise<number> {
    const owner = await this.deps.repo.owner(trigger.userId);
    if (!owner) return 0;
    const now = this.deps.clock.now();

    let sent = 0;
    for (const channel of action.channels) {
      const result = await this.deps.notifier.send({
        channel,
        to: { email: owner.email, userId: owner.id },
        template: 'REMIND_OWNER',
        variables: {
          name: owner.displayName,
          trigger: trigger.name,
          // The owner's own words, if they wrote any for this step.
          message: action.message ?? '',
          checkInUrl: `${this.deps.appBaseUrl}/check-in/${trigger.id}`,
        },
      });
      // Recorded as an ATTEMPT, not a delivery: a permanently bouncing address
      // must not hold someone's legacy hostage forever.
      await this.deps.repo.recordAttempt(trigger.id, action.stepId, action.occurrence, channel, now);
      if (result.ok) sent += 1;
    }
    return sent;
  }

  /**
   * Ask the people the owner named whether the owner is alright.
   *
   * They are told nothing else: not that a vault exists, not what is in it, not
   * who else was contacted, not who the recipients are. One question, in the
   * owner's own words, and a one-time link.
   */
  private async wellbeingCheck(
    trigger: TriggerRecord,
    action: Extract<Action, { kind: 'WELLBEING_CHECK' }>,
  ): Promise<number> {
    const owner = await this.deps.repo.owner(trigger.userId);
    let sent = 0;

    for (const contactId of action.contactIds) {
      const contact = await this.deps.repo.recipient(contactId);
      if (!contact) continue;

      // The token goes in the message; only its hash is stored. A reader of our
      // database cannot answer on someone else's behalf.
      const { token, hash } = this.deps.tokens.mint();
      await this.deps.repo.recordAnswerToken(trigger.id, contactId, hash);

      for (const channel of action.channels) {
        const result = await this.deps.notifier.send({
          channel,
          to: { email: contact.email, phone: contact.phone },
          template: 'WELLBEING_CHECK',
          variables: {
            contactName: contact.displayName,
            ownerName: owner?.displayName ?? 'someone who trusts you',
            script: action.script ?? '',
            answerUrl: `${this.deps.appBaseUrl}/wellbeing/${token}`,
            requiresOtp: action.requireOtp ? 'yes' : 'no',
          },
        });
        if (result.ok) sent += 1;
      }
    }

    if (sent > 0) {
      await this.deps.repo.appendAudit(
        trigger.userId, 'WELLBEING_CHECK',
        `${trigger.name}: asked ${action.contactIds.length} ${action.contactIds.length === 1 ? 'person' : 'people'} whether you are alright.`,
      );
    }
    return sent;
  }

  private async requestConfirmation(
    trigger: TriggerRecord,
    action: Extract<Action, { kind: 'REQUEST_CONFIRMATION' }>,
  ): Promise<number> {
    const owner = await this.deps.repo.owner(trigger.userId);
    let sent = 0;
    for (const contactId of action.from) {
      const contact = await this.deps.repo.recipient(contactId);
      if (!contact) continue;
      const { token, hash } = this.deps.tokens.mint();
      await this.deps.repo.recordAnswerToken(trigger.id, contactId, hash);
      const result = await this.deps.notifier.send({
        channel: contact.email ? 'EMAIL' : 'SMS',
        to: { email: contact.email, phone: contact.phone },
        template: 'CONFIRMATION_REQUEST',
        variables: {
          contactName: contact.displayName,
          ownerName: owner?.displayName ?? 'someone',
          answerUrl: `${this.deps.appBaseUrl}/wellbeing/${token}`,
        },
      });
      if (result.ok) sent += 1;
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
  private async deliver(trigger: TriggerRecord, now: number): Promise<number> {
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
      trigger.userId, 'DELIVERED',
      `${trigger.name}: released to ${sent} ${sent === 1 ? 'person' : 'people'}.`,
      { grants: grants.length, dispatched: sent },
    );
    return sent;
  }
}
