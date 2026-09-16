import React from 'react';
import { View } from 'react-native';
import { palette, space, radius } from '../theme/tokens.js';
import { Type } from './Type.js';
import { Card } from './Card.js';

/**
 * "Who can open this."
 *
 * The sentence comes from `describeCustody()` in @vigil/crypto — generated from
 * the actual grant, not written by us and not stored as marketing copy. If the
 * cryptography changes, this text changes with it, and if it ever says something
 * flattering that the code does not support, that is a bug in the code rather
 * than a nicer way of putting things.
 */

interface Props {
  /** Output of describeCustody(grant). */
  description: string;
  recipientName: string;
  mode: 'RECIPIENT_KEYED' | 'SPLIT_CUSTODY';
}

export function CustodyNote({ description, recipientName, mode }: Props) {
  const strongest = mode === 'RECIPIENT_KEYED';
  return (
    <Card tone="quiet" accent={strongest ? palette.sage : palette.amber}>
      <Type variant="label" color={strongest ? palette.sageText : palette.amberText}>
        {strongest ? 'Sealed to them alone' : 'Split between people'}
      </Type>
      <Type variant="heading" face="sans" style={{ marginTop: space.xs }}>
        Who can open {recipientName}’s vault
      </Type>
      <Type variant="body" color={palette.inkSoft} style={{ marginTop: space.sm }}>
        {description}
      </Type>

      {!strongest && (
        <View
          style={{
            marginTop: space.lg, padding: space.md,
            backgroundColor: palette.paperSunken, borderRadius: radius.md,
          }}
        >
          <Type variant="caption" color={palette.inkSoft}>
            {recipientName} hasn’t installed Vigil yet. Once they do, this vault can be
            re-sealed to their own key — and then nobody but them can open it, including us.
          </Type>
        </View>
      )}
    </Card>
  );
}
