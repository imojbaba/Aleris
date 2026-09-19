import React, { useEffect, useMemo, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useVigilFonts } from './src/theme/fonts.js';
import { palette } from './src/theme/tokens.js';
import { useVigil } from './src/store.js';
import { WhyScreen } from './src/screens/WhyScreen.js';
import { SetupScreen } from './src/screens/SetupScreen.js';
import { PeopleScreen } from './src/screens/PeopleScreen.js';
import { ArmTriggerScreen } from './src/screens/ArmTriggerScreen.js';
import { ComposeScreen } from './src/screens/ComposeScreen.js';
import { OutboxScreen } from './src/screens/OutboxScreen.js';
import { HomeScreen } from './src/screens/HomeScreen.js';

/**
 * App shell.
 *
 * A plain state machine rather than a navigation library: there are six
 * screens and the route graph is a line, so a router would mostly add a
 * dependency to audit. React Navigation earns its place when the vault browser
 * and deep links arrive, not before.
 */

type Route = 'people' | 'arm' | 'write' | 'outbox' | 'home';

export default function App() {
  const fonts = useVigilFonts();
  const vigil = useVigil();
  const [route, setRoute] = useState<Route | null>(null);
  /** Shown once, before anything is asked of a first-time visitor. */
  const [introDone, setIntroDone] = useState(false);

  const contactNames = useMemo(
    () => Object.fromEntries(vigil.data.people.map((p) => [p.id, p.name])),
    [vigil.data.people],
  );

  // Pin the starting route the moment we have one. Navigation is then driven
  // only by the user, never by a state change underneath them.
  const landing: Route =
    vigil.data.people.length === 0 ? 'people' : !vigil.data.workflow ? 'arm' : 'home';
  useEffect(() => {
    if (vigil.unlocked && route === null) setRoute(landing);
  }, [vigil.unlocked, route, landing]);

  // Hold the first paint until the type is ready — a flash of fallback serif
  // followed by a reflow is worse than a beat of nothing. A genuine load
  // failure carries on with the fallback stacks rather than trapping anyone.
  if (!fonts.loaded && !fonts.error) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.paper, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={palette.ember} />
      </View>
    );
  }

  const chrome = <StatusBar style="dark" />;

  if (!vigil.unlocked) {
    // A returning user knows what this is; only a new one needs the why.
    if (!vigil.hasAccount && !introDone) {
      return <>{chrome}<WhyScreen onBegin={() => setIntroDone(true)} /></>;
    }
    return <>{chrome}<SetupScreen vigil={vigil} /></>;
  }

  /**
   * Where a freshly unlocked user belongs, based on what they have done so far.
   * Pinned on arrival rather than recomputed: an earlier version derived the
   * route on every render, so adding your first person flipped the condition
   * and threw you off the People screen mid-task, before you could add a
   * second. Found by driving the app, not by reading it.
   */
  const current = route ?? (
    vigil.data.people.length === 0 ? 'people' : !vigil.data.workflow ? 'arm' : 'home'
  );

  switch (current) {
    case 'people':
      return (
        <>{chrome}
          <PeopleScreen
            vigil={vigil}
            onDone={() => setRoute(vigil.data.workflow ? 'home' : 'arm')}
          />
        </>
      );

    case 'arm':
      return (
        <>{chrome}
          <ArmTriggerScreen
            now={vigil.now()}
            prepare={vigil.suggestedWorkflow}
            contactNames={contactNames}
            onAddPeople={() => setRoute('people')}
            onBack={vigil.data.workflow ? () => setRoute('home') : undefined}
            onArm={(workflow) => { void vigil.arm(workflow); setRoute('home'); }}
          />
        </>
      );

    case 'write':
      return <>{chrome}<ComposeScreen vigil={vigil} onDone={() => setRoute('home')} /></>;

    case 'outbox':
      return <>{chrome}<OutboxScreen vigil={vigil} onBack={() => setRoute('home')} /></>;

    case 'home':
    default:
      if (!vigil.view) return <>{chrome}<ArmTriggerScreen
        now={vigil.now()}
        prepare={vigil.suggestedWorkflow}
        contactNames={contactNames}
        onAddPeople={() => setRoute('people')}
        onArm={(workflow) => { void vigil.arm(workflow); setRoute('home'); }}
      /></>;
      return (
        <>{chrome}
          <HomeScreen
            vigil={vigil}
            onPeople={() => setRoute('people')}
            onWrite={() => setRoute('write')}
            onOutbox={() => setRoute('outbox')}
            onEditTrigger={() => setRoute('arm')}
          />
        </>
      );
  }
}
