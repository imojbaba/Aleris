import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { DEFAULT_CONFIG, checkIn, milestones, type TriggerConfig, type TriggerState } from '@vigil/core';
import { HomeScreen } from './src/screens/HomeScreen.js';
import { ArmTriggerScreen } from './src/screens/ArmTriggerScreen.js';
import type { TriggerStatus } from './src/theme/status.js';

/**
 * App shell.
 *
 * Deliberately a plain state machine rather than a navigation library for the
 * MVP: there are two screens that matter and adding a router before there is
 * anything to route mostly adds a dependency to audit. React Navigation goes in
 * when the vault browser and recipient management land.
 */

export default function App() {
  const now = Date.now();
  const [config, setConfig] = useState<TriggerConfig | null>(null);
  const [state, setState] = useState<TriggerState>({
    status: 'DRAFT',
    lastCheckInAt: now,
    statusSince: now,
    attestations: [],
    nudgesSent: [],
  });

  if (!config) {
    return (
      <>
        <StatusBar style="dark" />
        <ArmTriggerScreen
          now={now}
          onArm={(chosen) => {
            setConfig(chosen);
            setState((s) => ({ ...s, status: 'ACTIVE', lastCheckInAt: Date.now() }));
          }}
        />
      </>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      <HomeScreen
        ownerName="Jo"
        triggerName="If I go quiet"
        status={state.status as TriggerStatus}
        config={config ?? DEFAULT_CONFIG}
        state={state}
        now={now}
        vaultCount={0}
        recipientCount={0}
        onCheckIn={() => setState((s) => checkIn(s, Date.now()))}
        onOpenVaults={() => {}}
      />
    </>
  );
}

export { milestones };
