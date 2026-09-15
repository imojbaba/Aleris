import React, { useMemo } from 'react';
import { ScrollView, View, SafeAreaView } from 'react-native';
import { humaniseDuration, plan, type Workflow, type TriggerState } from '@vigil/core';
import { STATUS, accentFor, type TriggerStatus } from '../theme/status.js';
import { palette, space } from '../theme/tokens.js';
import { Type } from '../components/Type.js';
import { Flame } from '../components/Flame.js';
import { PulseButton } from '../components/PulseButton.js';
import { Card } from '../components/Card.js';

/**
 * Home.
 *
 * One job: answer "am I alright, and has anything been sent?" before the user
 * has finished looking at the screen. Everything else — vaults, recipients,
 * settings — is one tap away and none of it is here.
 *
 * Note what is deliberately absent: a countdown in days by default. An
 * ever-present "37 days until your letters are sent" turns a quiet safeguard
 * into a memento mori on your home screen, and people delete apps that do that.
 * The number is available, phrased gently, below the fold.
 */

interface Props {
  ownerName: string;
  triggerName: string;
  status: TriggerStatus;
  workflow: Workflow;
  state: TriggerState;
  now: number;
  vaultCount: number;
  recipientCount: number;
  onCheckIn: () => void;
  onOpenVaults: () => void;
}

export function HomeScreen(props: Props) {
  const { status, workflow, state, now, ownerName } = props;
  const presentation = STATUS[status];
  const accent = accentFor(status);
  const p = useMemo(() => plan(workflow, state.lastCheckInAt), [workflow, state.lastCheckInAt]);

  const untilDue = p.dueAt - now;
  const isSettled = status === 'ACTIVE' || status === 'DRAFT' || status === 'PAUSED';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.paper }}>
      <ScrollView
        contentContainerStyle={{ padding: space.xl, paddingBottom: space.huge }}
        showsVerticalScrollIndicator={false}
      >
        <Type variant="label" color={palette.inkFaint}>
          {props.triggerName}
        </Type>

        <View style={{ alignItems: 'center', marginTop: space.xxl, marginBottom: space.xl }}>
          <Flame behaviour={presentation.flame} accent={accent} size={140} />
          <Type variant="display" center style={{ marginTop: space.lg }}>
            {presentation.headline}
          </Type>
          <Type
            variant="body"
            center
            color={palette.inkSoft}
            style={{ marginTop: space.sm, maxWidth: 320 }}
          >
            {presentation.detail}
          </Type>
        </View>

        <PulseButton onComplete={props.onCheckIn} disabled={status === 'DELIVERED' || status === 'CANCELLED'} />

        <Type variant="caption" center color={palette.inkFaint} style={{ marginTop: space.md }}>
          {untilDue > 0
            ? `Next check-in in ${humaniseDuration(untilDue)}. There is no hurry.`
            : isSettled
              ? 'Check in whenever you like.'
              : `Checking in now stops everything.`}
        </Type>

        {/* What is waiting, and for whom. Phrased as care, not inventory. */}
        <Card tone="quiet" style={{ marginTop: space.xxl }}>
          <Type variant="label" color={palette.inkFaint}>
            What you have made ready
          </Type>
          <Type variant="letter" style={{ marginTop: space.sm }}>
            {props.vaultCount === 0
              ? 'Nothing yet. When you are ready, start with one letter to one person.'
              : `${props.vaultCount} ${props.vaultCount === 1 ? 'vault' : 'vaults'}, for ${props.recipientCount} ${props.recipientCount === 1 ? 'person' : 'people'}.`}
          </Type>
          {props.vaultCount > 0 && (
            <Type variant="caption" color={palette.inkFaint} style={{ marginTop: space.sm }}>
              Only you can open these. They stay sealed until every condition you set is met.
            </Type>
          )}
        </Card>

        {/* The honest number, for people who want it. */}
        {isSettled && (
          <Type variant="caption" center color={palette.inkFaint} style={{ marginTop: space.xl }}>
            If you never opened this app again, nothing would be sent for{' '}
            {humaniseDuration(p.fireAt - now)} — and we would try to reach you many times
            first, {ownerName}.
          </Type>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
