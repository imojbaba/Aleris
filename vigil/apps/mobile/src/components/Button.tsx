import React from 'react';
import { Pressable, View } from 'react-native';
import { palette, radius, space } from '../theme/tokens.js';
import { Type } from './Type.js';

interface Props {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'quiet' | 'danger';
  disabled?: boolean;
  full?: boolean;
}

export function Button({ label, onPress, kind = 'primary', disabled, full = true }: Props) {
  const bg = kind === 'primary' ? palette.ink : 'transparent';
  const fg = kind === 'primary' ? palette.paper : kind === 'danger' ? palette.alert : palette.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={{
        height: 54,
        borderRadius: radius.pill,
        backgroundColor: disabled ? palette.hairline : bg,
        borderWidth: kind === 'primary' ? 0 : 1,
        borderColor: palette.hairline,
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: full ? 'stretch' : 'flex-start',
        paddingHorizontal: full ? 0 : space.xl,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Type variant="heading" face="sans" color={disabled ? palette.inkFaint : fg}>
        {label}
      </Type>
    </Pressable>
  );
}

export function Row({ children, gap = space.md }: { children: React.ReactNode; gap?: number }) {
  return <View style={{ flexDirection: 'row', gap, alignItems: 'center' }}>{children}</View>;
}
