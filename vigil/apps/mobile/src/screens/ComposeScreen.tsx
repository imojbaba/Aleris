import React, { useState } from 'react';
import { ScrollView, View, SafeAreaView, Pressable } from 'react-native';
import { palette, space, radius } from '../theme/tokens.js';
import { Type } from '../components/Type.js';
import { Field } from '../components/Field.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import type { Vigil } from '../store.js';

/**
 * Writing something, and sealing it.
 *
 * The encryption here is real: a random vault key per letter, wrapped under the
 * master key, with the title encrypted too — a vault called "For Maya, before
 * the operation" would otherwise give away most of the secret without anyone
 * decrypting a word.
 */
export function ComposeScreen({ vigil, onDone }: { vigil: Vigil; onDone: () => void }) {
  const recipients = vigil.data.people;
  const [personId, setPersonId] = useState(recipients[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sealed, setSealed] = useState(false);

  const person = vigil.peopleById(personId);
  const canSeal = personId && title.trim() && body.trim();

  if (sealed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.paper }}>
        <View style={{ flex: 1, padding: space.xl, justifyContent: 'center', alignItems: 'center' }}>
          <View
            style={{
              width: 56, height: 56, borderRadius: radius.pill,
              backgroundColor: palette.sageSoft, alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Type variant="title" color={palette.sageText}>✓</Type>
          </View>
          <Type variant="title" center style={{ marginTop: space.lg }}>Sealed.</Type>
          <Type variant="body" center color={palette.inkSoft} style={{ marginTop: space.sm, maxWidth: 300 }}>
            Encrypted on this device with a key of its own. Nobody can read it — not us, and not
            {person ? ` ${person.name}` : ' them'}, until your trigger runs.
          </Type>
          <View style={{ marginTop: space.xxl, alignSelf: 'stretch' }}>
            <Button label="Done" onPress={onDone} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.paper }}>
      <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: space.huge }}>
        <Type variant="title">What do you want to say?</Type>

        <Type variant="label" color={palette.inkFaint} style={{ marginTop: space.xl }}>To whom</Type>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm, marginBottom: space.lg }}>
          {recipients.map((p) => {
            const on = p.id === personId;
            return (
              <Pressable
                key={p.id}
                onPress={() => setPersonId(p.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={{
                  paddingVertical: space.sm, paddingHorizontal: space.lg,
                  borderRadius: radius.pill,
                  backgroundColor: on ? palette.ink : palette.paperRaised,
                  borderWidth: 1, borderColor: on ? palette.ink : palette.hairline,
                }}
              >
                <Type variant="caption" face="sans" color={on ? palette.paper : palette.ink}>
                  {p.name}
                </Type>
              </Pressable>
            );
          })}
        </View>

        <Field label="Give it a name" value={title} onChangeText={setTitle} placeholder="The thing about the garden" />
        <Field
          label="The letter"
          value={body}
          onChangeText={setBody}
          placeholder={person ? `${person.name} —` : 'Write as much or as little as you like.'}
          multiline
          numberOfLines={12}
          prose
          style={{ minHeight: 260, textAlignVertical: 'top' }}
          hint="Encrypted on this device the moment you seal it."
        />

        <Button
          label="Seal it"
          disabled={!canSeal}
          onPress={() => { vigil.writeLetter(personId, title.trim(), body.trim()); setSealed(true); }}
        />
        <View style={{ marginTop: space.md }}>
          <Button label="Not now" kind="quiet" onPress={onDone} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
