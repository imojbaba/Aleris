import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, type ViewStyle } from 'react-native';
import { palette } from '../theme/tokens.js';
import { motion } from '../theme/tokens.js';
import type { StatusPresentation } from '../theme/status.js';

/**
 * The flame.
 *
 * Vigil's single piece of ornament, and the app's entire status display. A
 * person should be able to tell whether they are fine from across a room,
 * without reading anything — this is the one place where a glanceable,
 * pre-verbal signal beats a sentence.
 *
 * The behaviours are deliberately NOT a severity ramp of colours. A steady warm
 * glow means all is well; dimming means we have missed you; a slow pulse means
 * we are trying to reach you. Nothing ever turns red, and nothing ever flashes:
 * this app should not be capable of frightening someone who is simply on
 * holiday.
 */

interface Props {
  behaviour: StatusPresentation['flame'];
  accent: string;
  size?: number;
  style?: ViewStyle;
}

export function Flame({ behaviour, accent, size = 120, style }: Props) {
  const breath = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (behaviour === 'out') {
      breath.stopAnimation();
      breath.setValue(0);
      return;
    }
    const period = behaviour === 'pulsing' ? motion.breath / 2.6 : motion.breath;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1, duration: period, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0, duration: period, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [behaviour, breath]);

  const amplitude = { steady: 0.06, dimming: 0.16, pulsing: 0.3, low: 0.04, out: 0 }[behaviour];
  const baseOpacity = { steady: 1, dimming: 0.55, pulsing: 0.9, low: 0.35, out: 0.12 }[behaviour];

  const scaleAnim = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1 + amplitude] });
  const opacityAnim = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [baseOpacity, Math.min(1, baseOpacity + amplitude)],
  });

  return (
    <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
      {/* Outer halo — the light the flame casts, not the flame. */}
      <Animated.View
        style={{
          position: 'absolute',
          width: size, height: size, borderRadius: size / 2,
          backgroundColor: accent, opacity: Animated.multiply(opacityAnim, 0.12),
          transform: [{ scale: scaleAnim }],
        }}
      />
      <Animated.View
        style={{
          position: 'absolute',
          width: size * 0.62, height: size * 0.62, borderRadius: size,
          backgroundColor: accent, opacity: Animated.multiply(opacityAnim, 0.22),
          transform: [{ scale: scaleAnim }],
        }}
      />
      {/* The flame body: a teardrop, made by rounding three corners of a square. */}
      <Animated.View
        style={{
          width: size * 0.3, height: size * 0.3,
          backgroundColor: accent,
          opacity: opacityAnim,
          borderTopLeftRadius: size * 0.3,
          borderTopRightRadius: size * 0.04,
          borderBottomLeftRadius: size * 0.3,
          borderBottomRightRadius: size * 0.3,
          transform: [{ rotate: '45deg' }, { scale: scaleAnim }],
        }}
      />
      {behaviour !== 'out' && (
        <Animated.View
          style={{
            position: 'absolute',
            width: size * 0.1, height: size * 0.1, borderRadius: size,
            backgroundColor: palette.paper, opacity: Animated.multiply(opacityAnim, 0.7),
            transform: [{ translateY: size * 0.03 }],
          }}
        />
      )}
    </View>
  );
}
