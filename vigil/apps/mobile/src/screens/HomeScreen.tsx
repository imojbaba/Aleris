import React from 'react';
import { ScrollView, View, SafeAreaView, Pressable } from 'react-native';
import { humaniseDuration } from '@vigil/core';
import { STATUS, accentFor, type TriggerStatus } from '../theme/status.js';
import { palette, space, radius } from '../theme/tokens.js';
import { Type } from '../components/Type.js';
import { Flame } from '../components/Flame.js';
import { PulseButton } from '../components/PulseButton.js';
import { Card } from '../components/Card.js';
import { Button, Row } from '../components/Button.js';
import { TimeMachine } from '../components/TimeMachine.js';
import type { Vigil } from '../store.js';

/**
 * Home.
 *
 * One job: answer "am I alright, and has anything been sent?" before you have
 * finished looking at the screen. Everything else is a tap away and none of it
 * is here.
 */
export function HomeScreen({
  vigil, onPeople, onWrite, onOutbox, onEditTrigger,
}: {
  vigil: Vigil;
  onPeople: () => void;
  onWrite: () => void;
  onOutbox: () => void;
  onEditTrigger: () => void;
}) {
  const view = vigil.view!;
  const status = view.decision.status as TriggerStatus;
  const presentation = STATUS[status];
  const accent = accentFor(status);
  const untilDue = view.plan.dueAt - view.now;
  const settled = status === 'ACTIVE' || status === 'PAUSED';
  const confirmers = vigil.data.people.filter((p) => p.isConfirmer);
  const asked = status === 'WELLBEING_CHECK' || status === 'AWAITING_CONFIRMATION';
  const finished = status === 'DELIVERED' || status === 'CANCELLED';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.paper }}>
      <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: space.huge }}>
        <Row>
          <Type variant="label" color={palette.inkFaint} style={{ flexGrow: 1 }}>
            {vigil.data.ownerName}’s trigger
          </Type>
          <Pressable onPress={onEditTrigger}>
            <Type variant="caption" color={palette.inkFaint}>Change</Type>
          </Pressable>
        </Row>

        <View style={{ alignItems: 'center', marginTop: space.xl, marginBottom: space.lg }}>
          <Flame behaviour={presentation.flame} accent={accent} size={132} />
          <Type variant="display" center style={{ marginTop: space.lg }}>
            {presentation.headline}
          </Type>
          <Type variant="body" center color={palette.inkSoft} style={{ marginTop: space.sm, maxWidth: 320 }}>
            {presentation.detail}
          </Type>
        </View>

        {!finished && (
          <>
            <PulseButton onComplete={vigil.checkIn} />
            <Type variant="caption" center color={palette.inkFaint} style={{ marginTop: space.md }}>
              {untilDue > 0
                ? `Next check-in in ${humaniseDuration(untilDue)}. There is no hurry.`
                : 'Checking in now stops everything.'}
            </Type>
          </>
        )}

        {/* The stand-down, from the other side. Someone answering the wellbeing
            check is the single most important thing that can happen here, so it
            is reachable rather than buried. */}
        {asked && confirmers.length > 0 && (
          <Card tone="sunken" accent={palette.sage} style={{ marginTop: space.xl }}>
            <Type variant="label" color={palette.sage}>Answering on their behalf</Type>
            <Type variant="body" color={palette.inkSoft} style={{ marginTop: space.xs }}>
              {confirmers.map((c) => c.name).join(' and ')} {confirmers.length === 1 ? 'has' : 'have'} been
              asked whether you’re alright. This is what they see — try replying as them.
            </Type>
            <View style={{ marginTop: space.md, gap: space.sm }}>
              {confirmers.map((c) => (
                <Row key={c.id}>
                  <Type variant="body" style={{ flexGrow: 1 }}>{c.name}</Type>
                  <Pressable
                    onPress={() => vigil.answerWellbeing(c.id, 'ALIVE')}
                    style={{
                      paddingVertical: space.sm, paddingHorizontal: space.lg,
                      borderRadius: radius.pill, backgroundColor: palette.sageSoft,
                    }}
                  >
                    <Type variant="caption" face="sans" color={palette.sage}>They’re fine</Type>
                  </Pressable>
                </Row>
              ))}
            </View>
          </Card>
        )}

        <Card tone="quiet" style={{ marginTop: space.xl }}>
          <Type variant="label" color={palette.inkFaint}>What you have made ready</Type>
          <Type variant="letter" style={{ marginTop: space.sm }}>
            {vigil.data.letters.length === 0
              ? 'Nothing yet. Start with one letter to one person.'
              : `${vigil.data.letters.length} ${vigil.data.letters.length === 1 ? 'letter' : 'letters'}, for ${new Set(vigil.data.letters.map((l) => l.personId)).size} ${new Set(vigil.data.letters.map((l) => l.personId)).size === 1 ? 'person' : 'people'}.`}
          </Type>
          <View style={{ marginTop: space.lg, gap: space.sm }}>
            <Button label="Write something" kind="quiet" onPress={onWrite} />
            <Button label={`People (${vigil.data.people.length})`} kind="quiet" onPress={onPeople} />
            <Button
              label={`What would be sent (${vigil.data.outbox.length})`}
              kind="quiet"
              onPress={onOutbox}
            />
          </View>
        </Card>

        {settled && !finished && (
          <Type variant="caption" center color={palette.inkFaint} style={{ marginTop: space.xl }}>
            If you never opened this app again, nothing would be sent for{' '}
            {humaniseDuration(view.plan.fireAt - view.now)} — and we would try to reach you many
            times first.
          </Type>
        )}

        <View style={{ marginTop: space.xxl }}>
          <TimeMachine offsetMs={vigil.data.offsetMs} onAdvance={vigil.advanceDays} />
        </View>

        <View style={{ marginTop: space.xl }}>
          <Button
            label={vigil.data.trigger?.status === 'PAUSED' ? 'Resume' : 'Pause everything'}
            kind="quiet"
            onPress={() => vigil.setPaused(vigil.data.trigger?.status !== 'PAUSED')}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
