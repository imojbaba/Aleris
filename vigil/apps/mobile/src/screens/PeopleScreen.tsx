import React, { useState } from 'react';
import { ScrollView, View, SafeAreaView, Pressable, Switch } from 'react-native';
import { palette, space, radius } from '../theme/tokens.js';
import { Type } from '../components/Type.js';
import { Field } from '../components/Field.js';
import { Button, Row } from '../components/Button.js';
import { Card } from '../components/Card.js';
import type { Vigil } from '../store.js';

/**
 * The people.
 *
 * This screen exists because running the app revealed it was missing: the
 * arming flow was correctly refusing to arm a workflow that asks nobody, and
 * there was no way to add anybody, so a new user hit a dead button on screen
 * one. A validator saying no is only half a product.
 *
 * Two roles, deliberately separate. Someone can receive what you left, or be
 * asked whether you are alright, or both — and a confirmer who receives nothing
 * is a perfectly sensible choice a lot of people will want.
 */
export function PeopleScreen({ vigil, onDone }: { vigil: Vigil; onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [isConfirmer, setIsConfirmer] = useState(true);
  const [adding, setAdding] = useState(vigil.data.people.length === 0);

  const canAdd = name.trim().length > 0 && email.includes('@');
  const confirmers = vigil.data.people.filter((p) => p.isConfirmer).length;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.paper }}>
      <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: space.huge }}>
        <Type variant="title">Who’s in your life?</Type>
        <Type variant="body" color={palette.inkSoft} style={{ marginTop: space.sm }}>
          Two different jobs, and one person can do both. Someone can be asked whether you’re
          alright — that’s all they’re ever asked, and they’re never shown what you’ve written. Or
          they can be someone you leave something to.
        </Type>

        <View style={{ marginTop: space.xl, gap: space.md }}>
          {vigil.data.people.map((person) => (
            <Card key={person.id} tone="quiet">
              <Row>
                <View style={{ flexGrow: 1 }}>
                  <Type variant="heading" face="sans">{person.name}</Type>
                  <Type variant="caption" color={palette.inkFaint}>{person.email}</Type>
                  <Type variant="caption" color={person.isConfirmer ? palette.sage : palette.inkFaint} style={{ marginTop: 4 }}>
                    {person.isConfirmer ? 'Will be asked if you’re alright' : 'Receives what you leave them'}
                    {vigil.lettersFor(person.id).length > 0
                      ? ` · ${vigil.lettersFor(person.id).length} letter${vigil.lettersFor(person.id).length === 1 ? '' : 's'}`
                      : ''}
                  </Type>
                </View>
                <Pressable onPress={() => vigil.removePerson(person.id)} accessibilityLabel={`Remove ${person.name}`}>
                  <Type variant="caption" color={palette.inkFaint}>Remove</Type>
                </Pressable>
              </Row>
            </Card>
          ))}
        </View>

        {adding ? (
          <Card tone="sunken" style={{ marginTop: space.lg }}>
            <Field label="Their name" value={name} onChangeText={setName} placeholder="Ray" />
            <Field
              label="Their email"
              value={email}
              onChangeText={setEmail}
              placeholder="ray@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <Row>
              <Switch
                value={isConfirmer}
                onValueChange={setIsConfirmer}
                trackColor={{ true: palette.sage, false: palette.hairline }}
              />
              <View style={{ flexShrink: 1 }}>
                <Type variant="body">Can be asked if I’m alright</Type>
                <Type variant="caption" color={palette.inkFaint}>
                  They’ll never see anything you’ve written.
                </Type>
              </View>
            </Row>
            <View style={{ marginTop: space.lg }}>
              <Button
                label="Add them"
                disabled={!canAdd}
                onPress={() => {
                  vigil.addPerson(name, email, isConfirmer);
                  setName(''); setEmail(''); setAdding(false);
                }}
              />
            </View>
          </Card>
        ) : (
          <View style={{ marginTop: space.lg }}>
            <Button label="Add someone" kind="quiet" onPress={() => setAdding(true)} />
          </View>
        )}

        <View style={{ marginTop: space.xxl }}>
          <Type variant="caption" color={confirmers > 0 ? palette.inkFaint : palette.amber}>
            {confirmers === 0
              ? 'Name at least one person who can be asked about you — it’s the single biggest thing that prevents a false alarm.'
              : `${confirmers} ${confirmers === 1 ? 'person' : 'people'} can be asked about you.`}
          </Type>
          <View style={{ marginTop: space.md }}>
            <Button label="Done" disabled={vigil.data.people.length === 0} onPress={onDone} />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
