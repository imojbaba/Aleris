import React from 'react';
import { View, Pressable } from 'react-native';
import { humaniseDuration } from '@vigil/core';
import { palette, radius, space } from '../theme/tokens.js';
import { Type } from './Type.js';

/**
 * The time machine.
 *
 * You cannot test a dead man's switch in real time. Left alone, the honest
 * answer to "does this work?" takes two months and a genuine disappearance.
 * So this build lets you wind the clock on and watch the real evaluator run
 * across the gap in six-hour ticks, filling the outbox with exactly what it
 * would have sent.
 *
 * It is visibly a testing instrument and says so — it is the one part of the
 * interface that must never be mistaken for the product.
 */

interface Props {
  offsetMs: number;
  onAdvance: (days: number) => void;
  disabled?: boolean;
}

const JUMPS = [1, 7, 30];

export function TimeMachine({ offsetMs, onAdvance, disabled }: Props) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: palette.inkFaint,
        borderRadius: radius.lg,
        padding: space.lg,
        backgroundColor: 'transparent',
      }}
    >
      <Type variant="label" color={palette.inkFaint}>Preview only — time machine</Type>
      <Type variant="caption" color={palette.inkSoft} style={{ marginTop: space.xs }}>
        {offsetMs > 0
          ? `You have wound the clock ${humaniseDuration(offsetMs)} forward.`
          : 'Wind the clock forward to watch your trigger actually run.'}
      </Type>

      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
        {JUMPS.map((d) => (
          <Pressable
            key={d}
            onPress={() => onAdvance(d)}
            disabled={disabled}
            accessibilityRole="button"
            style={{
              paddingVertical: space.sm,
              paddingHorizontal: space.lg,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: palette.hairline,
              backgroundColor: palette.paperRaised,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <Type variant="caption" face="sans" color={palette.ink}>
              +{d === 1 ? '1 day' : d === 7 ? '1 week' : '1 month'}
            </Type>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
