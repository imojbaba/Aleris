import React from 'react';
import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { palette, scale, type } from '../theme/tokens.js';

type Variant = keyof typeof scale;

interface Props extends TextProps {
  variant?: Variant;
  /** Serif is for words a person wrote. Sans is for the machinery. */
  face?: 'serif' | 'sans';
  color?: string;
  center?: boolean;
}

/**
 * The only text component. Ad-hoc <Text style={{fontSize: 17}}> is how a
 * type scale dies, and this product leans on typographic restraint to carry a
 * tone that a lot of colour and illustration would undermine.
 */
export function Type({ variant = 'body', face, color, center, style, ...rest }: Props) {
  const s = scale[variant];
  const isLetterish = variant === 'letter' || variant === 'display' || variant === 'title';
  const resolved = face ?? (isLetterish ? 'serif' : 'sans');

  const base: TextStyle = {
    fontSize: s.size,
    lineHeight: s.lineHeight,
    fontWeight: s.weight,
    fontFamily: resolved === 'serif' ? type.serif : type.sans,
    color: color ?? palette.ink,
    ...(center ? { textAlign: 'center' } : null),
    ...(variant === 'label' ? { letterSpacing: 0.6, textTransform: 'uppercase' } : null),
  };

  return <RNText {...rest} style={[base, style]} />;
}
