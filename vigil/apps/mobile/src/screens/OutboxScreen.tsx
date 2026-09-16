import React from 'react';
import { ScrollView, View, SafeAreaView } from 'react-native';
import { palette, space, radius } from '../theme/tokens.js';
import { Type } from '../components/Type.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import type { Vigil } from '../store.js';
import type { OutboxMessage } from '../lib/outbox.js';

/**
 * Everything the trigger would have sent.
 *
 * In this preview nothing actually leaves the device. That is not a limitation
 * to apologise for — it is the correct behaviour for a build whose purpose is
 * letting someone try a dead man's switch. The one thing a testing version of
 * this product must never do is tell a real family that someone has died.
 */

/** `edge` is a 3px rule (a fill); `text` is the label beside it. Different bars. */
const TONE: Record<OutboxMessage['kind'], { label: string; edge: string; text: string }> = {
  REMIND_OWNER: { label: 'To you', edge: palette.inkFaint, text: palette.inkFaint },
  WELLBEING_CHECK: { label: 'Wellbeing check', edge: palette.amber, text: palette.amberText },
  CONFIRMATION: { label: 'Asking to confirm', edge: palette.amber, text: palette.amberText },
  DELIVERY: { label: 'Delivered', edge: palette.ember, text: palette.emberText },
};

export function OutboxScreen({ vigil, onBack }: { vigil: Vigil; onBack: () => void }) {
  const messages = [...vigil.data.outbox].sort((a, b) => b.at - a.at);
  const fmt = (t: number) =>
    new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.paper }}>
      <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: space.huge }}>
        <Type variant="title">What would have been sent</Type>
        <Type variant="body" color={palette.inkSoft} style={{ marginTop: space.sm }}>
          Nothing has actually left this device. This is every message your trigger produced as the
          clock moved — the real wording, to the real people, on the real days.
        </Type>

        {messages.length === 0 ? (
          <Card tone="quiet" style={{ marginTop: space.xl }}>
            <Type variant="body" color={palette.inkFaint}>
              Nothing yet. Arm a trigger, then wind the clock forward past your check-in.
            </Type>
          </Card>
        ) : (
          <View style={{ marginTop: space.xl, gap: space.md }}>
            {messages.map((m) => {
              const tone = TONE[m.kind];
              return (
                <Card key={m.id} tone="quiet" accent={tone.edge}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Type variant="label" color={tone.text}>{tone.label}</Type>
                    <Type variant="caption" color={palette.inkFaint}>{fmt(m.at)}</Type>
                  </View>
                  <Type variant="caption" color={palette.inkFaint} style={{ marginTop: space.xs }}>
                    {m.channel.toLowerCase()} · {m.to}
                  </Type>
                  <Type variant="heading" face="sans" style={{ marginTop: space.sm }}>
                    {m.subject}
                  </Type>
                  <Type variant="body" color={palette.inkSoft} style={{ marginTop: space.sm }}>
                    {m.body}
                  </Type>
                </Card>
              );
            })}
          </View>
        )}

        <View style={{ marginTop: space.xxl }}>
          <Button label="Back" kind="quiet" onPress={onBack} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
