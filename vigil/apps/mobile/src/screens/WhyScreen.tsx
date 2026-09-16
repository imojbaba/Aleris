import React from 'react';
import { View, SafeAreaView, ScrollView } from 'react-native';
import Svg, { Path, Ellipse } from 'react-native-svg';
import { palette, space, radius } from '../theme/tokens.js';
import { Type } from '../components/Type.js';
import { Button } from '../components/Button.js';

/**
 * What this is, before anything is asked of you.
 *
 * The app opened straight onto a form asking for a name, an email and a
 * passphrase that can never be recovered — from someone who had not yet been
 * told what Vigil does. Maximum commitment at minimum trust, and the "no reset"
 * warning landing before there was any reason to accept it.
 *
 * This screen was in the design from the start and simply never made it into
 * the build. Its absence was the single largest usability problem in the app.
 */
export function WhyScreen({ onBegin }: { onBegin: () => void }) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.paper }}>
      <ScrollView
        contentContainerStyle={{
          padding: space.xl, paddingTop: space.xxxl, paddingBottom: space.xxl,
          flexGrow: 1, justifyContent: 'space-between',
        }}
      >
        <View style={{ alignItems: 'center' }}>
          <Svg width={64} height={78} viewBox="0 0 64 78">
            <Ellipse cx={32} cy={46} rx={30} ry={30} fill={palette.ember} opacity={0.07} />
            <Ellipse cx={32} cy={46} rx={19} ry={19} fill={palette.ember} opacity={0.13} />
            <Path
              d="M32 12 C 42 28, 50 34, 50 46 A 18 18 0 0 1 14 46 C 14 34, 22 28, 32 12 Z"
              fill={palette.ember}
            />
            <Path
              d="M32 34 C 37 42, 39 44, 39 50 A 7 7 0 0 1 25 50 C 25 44, 27 42, 32 34 Z"
              fill={palette.emberGlow}
              opacity={0.85}
            />
          </Svg>

          <View style={{ marginTop: space.xxl }}>
            <Type variant="display">We live as if there is always tomorrow.</Type>
            <Type variant="letter" color={palette.inkSoft} style={{ marginTop: space.lg }}>
              Mostly there is. But the photographs, the accounts, the thing you keep meaning to say
              to her — all of it assumes one more chance to sort it out.
            </Type>
            <Type variant="letter" color={palette.inkSoft} style={{ marginTop: space.lg }}>
              Vigil holds those things for you, sealed. It checks in on you, however often you
              choose. If you ever stop answering — and only after it has tried hard to reach you,
              and asked someone who knows you — it gives them to the people you chose.
            </Type>
          </View>
        </View>

        <View style={{ marginTop: space.xxl }}>
          <View
            style={{
              flexDirection: 'row', alignItems: 'flex-start', gap: space.md,
              padding: space.lg, backgroundColor: palette.paperSunken,
              borderRadius: radius.md, marginBottom: space.lg,
            }}
          >
            <Svg width={18} height={18} viewBox="0 0 24 24" style={{ marginTop: 2 }}>
              <Path
                d="M4 10.5h16v10H4z M8 10.5V7a4 4 0 0 1 8 0v3.5"
                fill="none" stroke={palette.sageText} strokeWidth={1.8}
                strokeLinecap="round" strokeLinejoin="round"
              />
            </Svg>
            <Type variant="caption" color={palette.inkSoft} style={{ flexShrink: 1 }}>
              Everything is locked on your phone before it reaches us. We hold it. We cannot read
              it — not for anyone, including ourselves.
            </Type>
          </View>

          <Button label="Begin" onPress={onBegin} />
          <Type variant="caption" center color={palette.inkFaint} style={{ marginTop: space.md }}>
            Takes a few minutes. You can stop anywhere, and change anything later.
          </Type>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
