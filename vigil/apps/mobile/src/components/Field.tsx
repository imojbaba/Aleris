import React from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { palette, radius, space, type } from '../theme/tokens.js';
import { weightedFamily } from '../theme/fonts.js';
import { Type } from './Type.js';

interface Props extends TextInputProps {
  label: string;
  hint?: string;
  /** Letters are set in the serif, at reading size. Everything else is UI. */
  prose?: boolean;
}

export function Field({ label, hint, prose, style, ...rest }: Props) {
  return (
    <View style={{ marginBottom: space.lg }}>
      <Type variant="label" color={palette.inkFaint}>{label}</Type>
      <TextInput
        placeholderTextColor={palette.inkFaint}
        {...rest}
        style={[
          {
            marginTop: space.xs,
            backgroundColor: palette.paperRaised,
            borderWidth: 1,
            borderColor: palette.hairline,
            borderRadius: radius.md,
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            fontSize: prose ? 18 : 16,
            lineHeight: prose ? 30 : 22,
            color: palette.ink,
            fontFamily: prose ? weightedFamily('serif', '300') : weightedFamily('sans', '400'),
          },
          style,
        ]}
      />
      {hint ? (
        <Type variant="caption" color={palette.inkFaint} style={{ marginTop: space.xs }}>
          {hint}
        </Type>
      ) : null}
    </View>
  );
}
