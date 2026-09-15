import React from 'react';
import { View } from 'react-native';
import type { TimelineEvent } from '@vigil/core';
import { palette, space, radius } from '../theme/tokens.js';
import { Type } from './Type.js';

/**
 * The cascade, drawn as a dated rail.
 *
 * Shown before a trigger can be armed, and never behind a "details" tap. The
 * specific harm this is here to prevent: someone configures a dead man's switch
 * in one reflective evening, pictures roughly what it does, and finds out years
 * later that it did something else. Sliders are bad at conveying consequence;
 * a dated list of "on this day, this person is contacted" is not.
 *
 * The marks matter. Steps that involve only the owner are drawn hollow and in
 * ink; steps where another human being hears from us are filled and in ember.
 * At a glance you can see the exact point where this stops being private.
 */

interface Props {
  events: TimelineEvent[];
  /** Formats a timestamp. Injected so tests and previews are deterministic. */
  formatDate?: (at: number) => string;
}

const defaultFormat = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function TimelineRail({ events, formatDate = defaultFormat }: Props) {
  return (
    <View>
      {events.map((event, i) => {
        const last = i === events.length - 1;
        const isRelease = event.kind === 'RELEASE';
        const colour = event.involvesOthers ? palette.ember : palette.inkFaint;

        return (
          <View key={`${event.kind}-${event.at}-${i}`} style={{ flexDirection: 'row' }}>
            {/* The rail itself */}
            <View style={{ width: 28, alignItems: 'center' }}>
              <View
                style={{
                  width: isRelease ? 14 : 10,
                  height: isRelease ? 14 : 10,
                  borderRadius: radius.pill,
                  borderWidth: 2,
                  borderColor: colour,
                  backgroundColor: event.involvesOthers ? colour : palette.paper,
                  marginTop: 5,
                }}
              />
              {!last && (
                <View style={{ flex: 1, width: 2, backgroundColor: palette.hairline, marginVertical: 4 }} />
              )}
            </View>

            <View style={{ flex: 1, paddingBottom: last ? 0 : space.xl }}>
              <Type variant="label" color={colour}>
                {formatDate(event.at)}
              </Type>
              <Type variant="heading" face="sans" style={{ marginTop: 2 }}>
                {event.title}
              </Type>
              <Type variant="body" color={palette.inkSoft} style={{ marginTop: space.xs }}>
                {event.detail}
              </Type>
            </View>
          </View>
        );
      })}
    </View>
  );
}
