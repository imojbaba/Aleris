import type { Action, Channel } from '@vigil/core';

/**
 * What would actually have been sent.
 *
 * In this preview nothing leaves the device — messages land in an in-app
 * outbox instead of a real inbox. That is a deliberate property of a TESTING
 * build: the one thing you must never do while trying out a dead man's switch
 * is accidentally tell someone's family they have died.
 *
 * The copy here is the real copy. It is the most consequential writing in the
 * product, because most of it is read by someone who did not install anything
 * and has no idea what Vigil is.
 */

export interface OutboxMessage {
  id: string;
  at: number;
  to: string;
  channel: Channel;
  kind: 'REMIND_OWNER' | 'WELLBEING_CHECK' | 'CONFIRMATION' | 'DELIVERY';
  subject: string;
  body: string;
}

export interface Addressee {
  id: string;
  name: string;
  email: string;
}

export function renderActions(
  action: Action,
  at: number,
  owner: { name: string; email: string },
  people: Addressee[],
  triggerName: string,
): OutboxMessage[] {
  const find = (id: string) => people.find((p) => p.id === id);
  const mk = (
    to: string, channel: Channel, kind: OutboxMessage['kind'], subject: string, body: string,
  ): OutboxMessage => ({
    id: `${at}-${kind}-${to}-${Math.random().toString(36).slice(2, 7)}`,
    at, to, channel, kind, subject, body,
  });

  switch (action.kind) {
    case 'REMIND_OWNER':
      return action.channels.map((channel) =>
        mk(owner.email, channel, 'REMIND_OWNER', 'Are you there?',
          `${owner.name} — we haven't heard from you.\n\n` +
          `${action.message ? `${action.message}\n\n` : ''}` +
          `Opening Vigil is enough. Nothing has been sent and nobody else has been contacted.\n\n` +
          `— Vigil, for "${triggerName}"`),
      );

    case 'WELLBEING_CHECK':
      return action.contactIds.flatMap((id) => {
        const person = find(id);
        if (!person) return [];
        return action.channels.map((channel) =>
          mk(person.email, channel, 'WELLBEING_CHECK', `Is ${owner.name} alright?`,
            action.script?.trim()
              ? `${action.script.trim()}\n\n` +
                `Reply: they're fine / I'm not sure / no.\n\n` +
                `You are not being asked for anything else, and you have not been told anything else.\n— Vigil`
              : `Hello ${person.name},\n\n` +
                `${owner.name} uses Vigil, and asked us to check with you if we ever couldn't reach them. ` +
                `We haven't been able to. Is everything alright?\n\n` +
                `Reply: they're fine / I'm not sure / no.\n\n` +
                `That is the only question. We can't tell you anything more, and there may be nothing wrong at all.\n— Vigil`),
        );
      });

    case 'REQUEST_CONFIRMATION':
      return action.from.flatMap((id) => {
        const person = find(id);
        return person
          ? [mk(person.email, 'EMAIL', 'CONFIRMATION', `A difficult question about ${owner.name}`,
              `Hello ${person.name},\n\n` +
              `${owner.name} named you as someone who would know. We have tried to reach them many ` +
              `times over several weeks and have had no reply.\n\n` +
              `Can you confirm what has happened? Nothing is sent to anyone until you do.\n— Vigil`)]
          : [];
      });

    case 'FIRE':
      return people.map((p) =>
        mk(p.email, 'EMAIL', 'DELIVERY', `${owner.name} left this for you`,
          `${p.name},\n\n` +
          `${owner.name} left something for you, and asked us to wait until they had been quiet ` +
          `for a while before passing it on. We waited, and we tried many times to reach them first.\n\n` +
          `There is no rush. It will still be here tomorrow, and next year.\n\n` +
          `Open when you're ready: vigil.app/for-you/…\n— Vigil`),
      );

    case 'STAND_DOWN':
      return [];
  }
}
