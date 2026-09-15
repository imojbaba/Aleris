import React from 'react';
import { View, type ViewProps } from 'react-native';
import { palette, radius, space, elevation } from '../theme/tokens.js';

interface Props extends ViewProps {
  tone?: 'raised' | 'sunken' | 'quiet';
  accent?: string;
}

export function Card({ tone = 'raised', accent, style, children, ...rest }: Props) {
  return (
    <View
      {...rest}
      style={[
        {
          backgroundColor: tone === 'sunken' ? palette.paperSunken : palette.paperRaised,
          borderRadius: radius.lg,
          padding: space.xl,
          borderWidth: tone === 'quiet' ? 1 : 0,
          borderColor: palette.hairline,
          ...(accent ? { borderLeftWidth: 3, borderLeftColor: accent } : null),
          ...(tone === 'raised' ? elevation.resting : null),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
