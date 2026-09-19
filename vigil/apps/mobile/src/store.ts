import { useCallback, useMemo, useRef, useState } from 'react';
import {
  type TriggerState, type Workflow,
  evaluate, applyDecision, checkIn as coreCheckIn, pause as corePause, resume as coreResume,
  freshState, recordAttestation, plan, withContacts, STEADY, hours, days,
} from '@vigil/core';
import {
  createIdentity, unlockIdentity, createVault, openVault, encryptText, decryptText,
  generateKeyPair, toB64u, type StoredIdentity,
} from '@vigil/crypto';
import { load, save, clear } from './lib/storage.js';
import { renderActions, type OutboxMessage } from './lib/outbox.js';
import { createClient, isConnected } from './lib/api.js';

/**
 * The app's state, and the time machine.
 *
 * A dead man's switch cannot be tested in real time — you would wait two months
 * to see whether the second reminder goes out. So this build carries a clock
 * offset the user can push forward, and `advanceDays` runs the real evaluator
 * in six-hour ticks across the gap, exactly as the worker would, collecting
 * every message it would have sent.
 *
 * Nothing here is a mock. It is @vigil/core deciding and @vigil/crypto
 * encrypting; the only substitution is that messages land in an in-app outbox
 * rather than in somebody's actual inbox — which is the one substitution a
 * testing build of THIS product must make.
 */

export interface Person {
  id: string;
  name: string;
  email: string;
  /** Someone we may ask "is she alright?". They never see vault contents. */
  isConfirmer: boolean;
}

export interface Letter {
  id: string;
  personId: string;
  wrappedVaultKey: string;
  encryptedTitle: string;
  ciphertext: string;
  createdAt: number;
}

interface Persisted {
  v: 1;
  ownerName: string;
  ownerEmail: string;
  identity: StoredIdentity | null;
  people: Person[];
  letters: Letter[];
  workflow: Workflow | null;
  trigger: TriggerState | null;
  outbox: OutboxMessage[];
  offsetMs: number;
  lastEvaluatedAt: number | null;
}

const EMPTY: Persisted = {
  v: 1, ownerName: '', ownerEmail: '', identity: null, people: [], letters: [],
  workflow: null, trigger: null, outbox: [], offsetMs: 0, lastEvaluatedAt: null,
};

const id = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

export function useVigil() {
  const [data, setData] = useState<Persisted>(() => load<Persisted>() ?? EMPTY);
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * Anything the server rejected or could not be told.
   *
   * Surfaced rather than swallowed: if the server does not know about a
   * trigger, nothing will fire when the phone is off — which is the entire
   * product failing silently, and the user has to be able to see it.
   */
  const [syncError, setSyncError] = useState<string | null>(null);
  const client = useRef(createClient());
  /** The master key never goes to storage; it lives here for the session only. */
  const masterKey = useRef<Uint8Array | null>(null);

  const commit = useCallback((next: Persisted) => {
    setData(next);
    save(next);
  }, []);

  /** "Now" as the app sees it: the real clock plus whatever the user wound on. */
  const now = useCallback(() => Date.now() + data.offsetMs, [data.offsetMs]);

  const createAccount = useCallback(
    async (name: string, email: string, passphrase: string) => {
      setBusy(true);
      // Yield so the spinner paints before Argon2id blocks the thread.
      await new Promise((r) => setTimeout(r, 30));
      try {
        const { masterKey: mk, stored } = createIdentity(passphrase);
        masterKey.current = mk;
        setUnlocked(true);
        commit({ ...EMPTY, ownerName: name.trim(), ownerEmail: email.trim(), identity: stored });

        // The server is handed the WRAPPED identity so a new phone can restore.
        // It cannot open it: the passphrase never leaves this device.
        if (client.current) {
          try {
            await client.current.register({
              email: email.trim(),
              displayName: name.trim(),
              identity: stored,
              publicKey: toB64u(generateKeyPair().publicKey),
            });
            setSyncError(null);
          } catch (e) {
            setSyncError((e as Error).message);
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [commit],
  );

  const unlock = useCallback(
    async (passphrase: string): Promise<boolean> => {
      if (!data.identity) return false;
      setBusy(true);
      await new Promise((r) => setTimeout(r, 30));
      try {
        masterKey.current = unlockIdentity(passphrase, data.identity);
        setUnlocked(true);
        return true;
      } catch {
        return false; // Wrong passphrase. There is no other way to tell.
      } finally {
        setBusy(false);
      }
    },
    [data.identity],
  );

  const addPerson = useCallback(
    (name: string, email: string, isConfirmer: boolean) => {
      const person: Person = { id: id('p'), name: name.trim(), email: email.trim(), isConfirmer };
      commit({ ...data, people: [...data.people, person] });
      return person;
    },
    [commit, data],
  );

  const removePerson = useCallback(
    (personId: string) => {
      commit({
        ...data,
        people: data.people.filter((p) => p.id !== personId),
        letters: data.letters.filter((l) => l.personId !== personId),
      });
    },
    [commit, data],
  );

  /** Writes a letter and seals it. Real AEAD, real key hierarchy. */
  const writeLetter = useCallback(
    (personId: string, title: string, body: string) => {
      if (!masterKey.current) throw new Error('locked');
      const letterId = id('l');
      const { vaultKey, wrappedVaultKey } = createVault(masterKey.current, letterId);
      const letter: Letter = {
        id: letterId,
        personId,
        wrappedVaultKey,
        encryptedTitle: encryptText(vaultKey, letterId, 'title', title),
        ciphertext: encryptText(vaultKey, letterId, 'body', body),
        createdAt: now(),
      };
      commit({ ...data, letters: [...data.letters, letter] });
    },
    [commit, data, now],
  );

  const readLetter = useCallback((letter: Letter): { title: string; body: string } | null => {
    if (!masterKey.current) return null;
    try {
      const vaultKey = openVault(masterKey.current, letter.id, letter.wrappedVaultKey);
      return {
        title: decryptText(vaultKey, letter.id, 'title', letter.encryptedTitle),
        body: decryptText(vaultKey, letter.id, 'body', letter.ciphertext),
      };
    } catch {
      return null;
    }
  }, []);

  const arm = useCallback(
    async (workflow: Workflow) => {
      const t = now();
      commit({ ...data, workflow, trigger: freshState(t), lastEvaluatedAt: t, outbox: [] });

      /**
       * Tell the server, so the cascade can run while this phone is off.
       *
       * Recipients go up first, because a workflow referencing contact ids the
       * server has never heard of is a workflow it cannot act on.
       */
      if (client.current) {
        try {
          const remoteIds: Record<string, string> = {};
          for (const p of data.people) {
            const r = await client.current.createRecipient({
              displayName: p.name, email: p.email,
            });
            remoteIds[p.id] = r.id;
          }
          const remapped: Workflow = {
            ...workflow,
            steps: workflow.steps.map((step) =>
              step.kind === 'WELLBEING_CHECK'
                ? { ...step, contactIds: step.contactIds.map((id) => remoteIds[id] ?? id) }
                : step.kind === 'REQUIRE_CONFIRMATION'
                  ? { ...step, from: step.from.map((id) => remoteIds[id] ?? id) }
                  : step,
            ),
          };
          await client.current.createTrigger({ name: 'My trigger', workflow: remapped as never });
          setSyncError(null);
        } catch (e) {
          setSyncError((e as Error).message);
        }
      }
    },
    [commit, data, now],
  );

  const checkIn = useCallback(() => {
    if (!data.trigger) return;
    const t = now();
    commit({ ...data, trigger: coreCheckIn(data.trigger, t), lastEvaluatedAt: t });
  }, [commit, data, now]);

  const setPaused = useCallback(
    (paused: boolean) => {
      if (!data.trigger) return;
      const t = now();
      commit({
        ...data,
        trigger: paused ? corePause(data.trigger, t) : coreResume(data.trigger, t),
        lastEvaluatedAt: t,
      });
    },
    [commit, data, now],
  );

  /** Someone answers the wellbeing check. This is what stops everything. */
  const answerWellbeing = useCallback(
    (personId: string, verdict: 'ALIVE' | 'DECEASED' | 'UNSURE') => {
      if (!data.trigger) return;
      commit({
        ...data,
        trigger: recordAttestation(data.trigger, { contactId: personId, verdict, at: now(), otpVerified: true }),
      });
    },
    [commit, data, now],
  );

  /**
   * Wind the clock forward and let the workflow run.
   *
   * Ticks every six hours, like the worker, so a jump of two months produces
   * the same sequence of messages in the same order as two months of real time
   * would. Anything else would be a simulation of the product rather than the
   * product.
   */
  const advanceDays = useCallback(
    (n: number) => {
      const { workflow, trigger } = data;
      const offsetMs = data.offsetMs + days(n);
      if (!workflow || !trigger) {
        commit({ ...data, offsetMs });
        return;
      }

      const target = Date.now() + offsetMs;
      let clock = data.lastEvaluatedAt ?? trigger.lastCheckInAt;
      let state = trigger;
      const outbox = [...data.outbox];
      const owner = { name: data.ownerName, email: data.ownerEmail };

      let guard = 0;
      while (clock < target && guard++ < 20_000) {
        clock = Math.min(target, clock + hours(6));
        const decision = evaluate(workflow, state, clock);
        for (const action of decision.actions) {
          outbox.push(...renderActions(action, clock, owner, data.people, 'your trigger'));
        }
        state = applyDecision(state, decision, clock);
      }

      commit({ ...data, offsetMs, trigger: state, outbox, lastEvaluatedAt: target });
    },
    [commit, data],
  );

  const reset = useCallback(() => {
    masterKey.current = null;
    setUnlocked(false);
    clear();
    setData(EMPTY);
  }, []);

  /** Live view of where the trigger stands right now. */
  const view = useMemo(() => {
    if (!data.workflow || !data.trigger) return null;
    const t = now();
    const decision = evaluate(data.workflow, data.trigger, t);
    return { decision, plan: plan(data.workflow, data.trigger.lastCheckInAt), now: t };
  }, [data.workflow, data.trigger, now]);

  /** A template with this user's confirmers filled in, ready to arm. */
  const suggestedWorkflow = useCallback(
    (base: Workflow = STEADY) =>
      withContacts(base, data.people.filter((p) => p.isConfirmer).map((p) => p.id)),
    [data.people],
  );

  return {
    data, view, unlocked, busy, now, syncError, connected: isConnected,
    hasAccount: data.identity !== null,
    masterKeyPresent: masterKey.current !== null,
    createAccount, unlock, addPerson, removePerson, writeLetter, readLetter,
    arm, checkIn, setPaused, answerWellbeing, advanceDays, reset, suggestedWorkflow,
    peopleById: (pid: string) => data.people.find((p) => p.id === pid) ?? null,
    lettersFor: (pid: string) => data.letters.filter((l) => l.personId === pid),
    fingerprint: data.identity ? toB64u(new TextEncoder().encode(data.identity.kdfSalt)).slice(0, 8) : '',
  };
}

export type Vigil = ReturnType<typeof useVigil>;
