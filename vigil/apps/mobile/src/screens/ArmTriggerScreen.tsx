import React, { useMemo, useState } from 'react';
import { ScrollView, View, Pressable, SafeAreaView } from 'react-native';
import {
  PRESETS, previewTimeline, summariseFuse, validateConfig, isValid, type TriggerConfig,
} from '@vigil/core';
import { palette, space, radius } from '../theme/tokens.js';
import { Type } from '../components/Type.js';
import { Card } from '../components/Card.js';
import { TimelineRail } from '../components/TimelineRail.js';

/**
 * Arming a trigger.
 *
 * The flow is preset → forecast → confirm, in that order and never reordered.
 * Nobody should have to design a cascade from an empty form, and nobody should
 * be able to arm one without having seen, on dated rows, the day their letters
 * would go out and the point at which another person first hears from us.
 *
 * Errors block. Warnings do not — they are shown in full and the user may
 * proceed, because a person who has thought about this is allowed to disagree
 * with us about their own life.
 */

interface Props {
  now: number;
  onArm: (config: TriggerConfig) => void;
}

export function ArmTriggerScreen({ now, onArm }: Props) {
  const [presetId, setPresetId] = useState(PRESETS[1]!.id);
  const config = useMemo(
    () => PRESETS.find((p) => p.id === presetId)!.config,
    [presetId],
  );
  const issues = useMemo(() => validateConfig(config), [config]);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const timeline = useMemo(() => previewTimeline(config, now), [config, now]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.paper }}>
      <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: space.huge }}>
        <Type variant="title">How will we know?</Type>
        <Type variant="body" color={palette.inkSoft} style={{ marginTop: space.sm }}>
          Choose how often you’ll check in. You can change this whenever you like, and pause it
          entirely while you’re away.
        </Type>

        <View style={{ marginTop: space.xl, gap: space.md }}>
          {PRESETS.map((preset) => {
            const selected = preset.id === presetId;
            return (
              <Pressable
                key={preset.id}
                onPress={() => setPresetId(preset.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
              >
                <Card tone={selected ? 'raised' : 'quiet'} accent={selected ? palette.ember : undefined}>
                  <Type variant="heading" face="sans">{preset.name}</Type>
                  <Type variant="body" color={palette.inkSoft} style={{ marginTop: space.xs }}>
                    {preset.blurb}
                  </Type>
                </Card>
              </Pressable>
            );
          })}
        </View>

        <View style={{ marginTop: space.xxl }}>
          <Type variant="label" color={palette.inkFaint}>Exactly what would happen</Type>
          <Type variant="title" style={{ marginTop: space.xs, marginBottom: space.lg }}>
            {summariseFuse(config)}
          </Type>
          <TimelineRail events={timeline} />
        </View>

        {warnings.length > 0 && (
          <Card tone="sunken" style={{ marginTop: space.xxl }}>
            <Type variant="label" color={palette.amber}>Worth thinking about</Type>
            {warnings.map((w) => (
              <Type key={w.field} variant="body" color={palette.inkSoft} style={{ marginTop: space.sm }}>
                {w.message}
              </Type>
            ))}
          </Card>
        )}

        {errors.length > 0 && (
          <Card tone="sunken" style={{ marginTop: space.lg }}>
            <Type variant="label" color={palette.alert}>This can’t be armed yet</Type>
            {errors.map((e) => (
              <Type key={e.field} variant="body" color={palette.inkSoft} style={{ marginTop: space.sm }}>
                {e.message}
              </Type>
            ))}
          </Card>
        )}

        <Pressable
          onPress={() => onArm(config)}
          disabled={!isValid(config)}
          accessibilityRole="button"
          style={{
            marginTop: space.xxl, height: 58, borderRadius: radius.pill,
            backgroundColor: isValid(config) ? palette.ink : palette.hairline,
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Type variant="heading" face="sans" color={palette.paper}>
            Arm this trigger
          </Type>
        </Pressable>

        <Type variant="caption" center color={palette.inkFaint} style={{ marginTop: space.md }}>
          You can pause, change or cancel this at any time. Nothing is ever sent while it is paused.
        </Type>
      </ScrollView>
    </SafeAreaView>
  );
}
