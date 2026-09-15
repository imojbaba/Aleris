import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { STEADY, checkIn, freshState, plan, type Workflow, type TriggerState } from '@vigil/core';
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
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [state, setState] = useState<TriggerState>(freshState(now, 'DRAFT'));

  if (!workflow) {
    return (
      <>
        <StatusBar style="dark" />
        <ArmTriggerScreen
          now={now}
          onArm={(chosen) => {
            setWorkflow(chosen);
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
        workflow={workflow ?? STEADY}
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

export { plan };
