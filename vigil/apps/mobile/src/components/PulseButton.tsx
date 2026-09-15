import React, { useCallback, useRef, useState } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { palette, radius, motion, space } from '../theme/tokens.js';
import { Type } from './Type.js';

/**
 * The check-in.
 *
 * This is the interaction people will perform most and remember the product by,
 * so it is a press-and-hold rather than a tap. Three reasons, in order of
 * importance:
 *
 *  1. It cannot be done by accident, and it cannot be done by a pocket. A tap
 *     target that says "I am alive" must not be reachable by a phone rattling
 *     in a bag.
 *  2. It takes about a second and a half, which is long enough to be a small
 *     ritual — a moment of noticing you are here — rather than dismissing a
 *     notification. Several early notes on this product came back to the same
 *     idea: people want the check-in to feel like something, not like a chore.
 *  3. The fill gives the gesture a shape, and the haptic at completion gives it
 *     a full stop.
 */

interface Props {
  onComplete: () => void;
  label?: string;
  holdLabel?: string;
  disabled?: boolean;
}

export function PulseButton({
  onComplete,
  label = "I'm here",
  holdLabel = 'Hold…',
  disabled = false,
}: Props) {
  const fill = useRef(new Animated.Value(0)).current;
  const [holding, setHolding] = useState(false);
  const completed = useRef(false);

  const start = useCallback(() => {
    if (disabled) return;
    completed.current = false;
    setHolding(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    Animated.timing(fill, {
      toValue: 1,
      duration: motion.pulseHold,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (!finished || completed.current) return;
      completed.current = true;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onComplete();
    });
  }, [disabled, fill, onComplete]);

  const cancel = useCallback(() => {
    setHolding(false);
    if (completed.current) {
      // Let the completed state rest a beat before resetting, so the gesture
      // visibly finishes rather than snapping back.
      setTimeout(() => fill.setValue(0), motion.settle);
      return;
    }
    Animated.timing(fill, {
      toValue: 0, duration: motion.quick, easing: Easing.out(Easing.quad), useNativeDriver: false,
    }).start();
  }, [fill]);

  const width = fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <Pressable
      onPressIn={start}
      onPressOut={cancel}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${label}. Press and hold to check in.`}
      accessibilityState={{ disabled }}
      style={{
        height: 64,
        borderRadius: radius.pill,
        backgroundColor: palette.paperSunken,
        borderWidth: 1,
        borderColor: palette.hairline,
        overflow: 'hidden',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Animated.View
        style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width,
          backgroundColor: palette.emberGlow,
        }}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm }}>
        <View
          style={{
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: holding ? palette.ember : palette.sage,
          }}
        />
        <Type variant="heading" face="sans" color={palette.ink}>
          {holding ? holdLabel : label}
        </Type>
      </View>
    </Pressable>
  );
}
