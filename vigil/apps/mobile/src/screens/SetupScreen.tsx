import React, { useState } from 'react';
import { ScrollView, View, SafeAreaView, ActivityIndicator } from 'react-native';
import { palette, space } from '../theme/tokens.js';
import { Type } from '../components/Type.js';
import { Field } from '../components/Field.js';
import { Button } from '../components/Button.js';
import type { Vigil } from '../store.js';

/**
 * Setting a passphrase, and being told plainly what that means.
 *
 * There is no reset. Saying so here, before anything is written, is the only
 * fair moment — afterwards it is an excuse rather than a warning.
 */
export function SetupScreen({ vigil }: { vigil: Vigil }) {
  const returning = vigil.hasAccount;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [failed, setFailed] = useState(false);

  const canCreate = name.trim().length > 0 && email.includes('@') && passphrase.length >= 8;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.paper }}>
      <ScrollView contentContainerStyle={{ padding: space.xl, paddingTop: space.xxxl }}>
        {returning ? (
          <>
            <Type variant="title">Welcome back.</Type>
            <Type variant="body" color={palette.inkSoft} style={{ marginTop: space.sm, marginBottom: space.xl }}>
              Your vaults are on this device, sealed. Your passphrase is the only thing that opens them.
            </Type>
            <Field
              label="Passphrase"
              value={passphrase}
              onChangeText={(t) => { setPassphrase(t); setFailed(false); }}
              secureTextEntry
              autoCapitalize="none"
              placeholder="the words you chose"
            />
            {failed && (
              <Type variant="caption" color={palette.alert} style={{ marginBottom: space.lg }}>
                That isn’t it. We can’t tell you anything more than that, and we can’t reset it.
              </Type>
            )}
            {vigil.busy ? (
              <ActivityIndicator color={palette.ember} />
            ) : (
              <Button
                label="Unlock"
                disabled={passphrase.length === 0}
                onPress={async () => { if (!(await vigil.unlock(passphrase))) setFailed(true); }}
              />
            )}
            <View style={{ marginTop: space.xxl }}>
              <Button label="Start over (erases everything)" kind="danger" onPress={vigil.reset} />
            </View>
          </>
        ) : (
          <>
            <Type variant="display">Let’s begin.</Type>
            <Type variant="letter" color={palette.inkSoft} style={{ marginTop: space.md, marginBottom: space.xl }}>
              Everything you write is locked on this device before it goes anywhere. We hold it. We
              cannot read it.
            </Type>

            <Field label="Your name" value={name} onChangeText={setName} placeholder="Jo" />
            <Field
              label="Your email"
              value={email}
              onChangeText={setEmail}
              placeholder="jo@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
              hint="Where we’ll check in with you."
            />
            <Field
              label="Passphrase"
              value={passphrase}
              onChangeText={setPassphrase}
              secureTextEntry
              autoCapitalize="none"
              placeholder="at least 8 characters"
              hint="Pick something you’ll still know in ten years."
            />

            <View
              style={{
                backgroundColor: palette.paperSunken, borderRadius: 14,
                padding: space.lg, marginBottom: space.xl,
              }}
            >
              <Type variant="label" color={palette.amberText}>Read this part</Type>
              <Type variant="body" color={palette.inkSoft} style={{ marginTop: space.sm }}>
                There is no “forgot passphrase”. Not a hard one — there is no way at all. If you lose
                it, everything in your vaults is gone, including for the people you leave it to.
                That is the direct cost of us not being able to read it.
              </Type>
            </View>

            {vigil.busy ? (
              <ActivityIndicator color={palette.ember} />
            ) : (
              <Button
                label="Create my vault"
                disabled={!canCreate}
                onPress={() => vigil.createAccount(name, email, passphrase)}
              />
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
