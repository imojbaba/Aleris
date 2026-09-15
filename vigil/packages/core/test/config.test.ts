import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONFIG, PRESETS, type TriggerConfig,
  validateConfig, isValid, totalFuseLength, SAFE_MINIMUM_TOTAL, HARD_MINIMUM_TOTAL,
  days, previewTimeline, summariseFuse, humaniseDuration,
} from '../src/index.js';

const errors = (c: TriggerConfig) => validateConfig(c).filter((i) => i.severity === 'error');
const fields = (c: TriggerConfig) => errors(c).map((i) => i.field);

describe('defaults and presets', () => {
  it('the shipped default is valid', () => expect(isValid(DEFAULT_CONFIG)).toBe(true));

  it('every preset is valid and clears the safe minimum', () => {
    for (const preset of PRESETS) {
      expect(isValid(preset.config), preset.id).toBe(true);
      expect(totalFuseLength(preset.config), preset.id).toBeGreaterThanOrEqual(SAFE_MINIMUM_TOTAL);
    }
  });

  it('presets are ordered from most to least patient', () => {
    const lengths = PRESETS.map((p) => totalFuseLength(p.config));
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });
});

describe('validation refuses configurations that could hurt someone', () => {
  it('rejects a single-channel escalation', () => {
    const c: TriggerConfig = { ...DEFAULT_CONFIG, escalation: [{ afterDays: 0, channels: ['EMAIL'] }] };
    expect(fields(c)).toContain('escalation');
    expect(errors(c)[0]!.message).toMatch(/bounced mailbox/);
  });

  it('rejects an empty escalation ladder — never release in silence', () => {
    expect(fields({ ...DEFAULT_CONFIG, escalation: [] })).toContain('escalation');
  });

  it('demands explicit acknowledgement for a fuse shorter than three weeks', () => {
    const rapid: TriggerConfig = {
      ...DEFAULT_CONFIG, checkInIntervalDays: 2, graceDays: 1,
      escalation: [{ afterDays: 0, channels: ['SMS', 'EMAIL'] }],
      verification: { ...DEFAULT_CONFIG.verification, holdDays: 1 },
    };
    expect(totalFuseLength(rapid)).toBeLessThan(SAFE_MINIMUM_TOTAL);
    expect(fields(rapid)).toContain('acknowledgedRapidRelease');
    // ...but it IS allowed once acknowledged. Short fuses are a real need.
    expect(isValid({ ...rapid, acknowledgedRapidRelease: true })).toBe(true);
  });

  it('refuses a sub-24-hour fuse even when acknowledged', () => {
    const absurd: TriggerConfig = {
      ...DEFAULT_CONFIG, checkInIntervalDays: 0.1, graceDays: 0,
      escalation: [{ afterDays: 0, channels: ['SMS', 'EMAIL'] }],
      verification: { ...DEFAULT_CONFIG.verification, holdDays: 0 },
      acknowledgedRapidRelease: true,
    };
    expect(totalFuseLength(absurd)).toBeLessThan(HARD_MINIMUM_TOTAL);
    expect(errors(absurd).map((e) => e.message).join(' ')).toMatch(/under 24 hours/);
  });

  it('catches a trigger that could never fire', () => {
    const impossible: TriggerConfig = {
      ...DEFAULT_CONFIG,
      verification: { verifierIds: ['ray'], requiredAttestations: 3, policy: 'REQUIRE_ATTESTATION', holdDays: 7 },
    };
    expect(errors(impossible).map((e) => e.message).join(' ')).toMatch(/could never fire/);
  });

  it('catches requiring confirmation from nobody', () => {
    const c: TriggerConfig = {
      ...DEFAULT_CONFIG,
      verification: { verifierIds: [], requiredAttestations: 0, policy: 'REQUIRE_ATTESTATION', holdDays: 7 },
    };
    expect(fields(c)).toContain('verification.verifierIds');
  });

  it('rejects negative durations', () => {
    expect(fields({ ...DEFAULT_CONFIG, graceDays: -1 })).toContain('graceDays');
    expect(fields({ ...DEFAULT_CONFIG, checkInIntervalDays: 0 })).toContain('checkInIntervalDays');
  });
});

describe('validation warns without blocking', () => {
  it('warns when nobody is checking on the owner, but still allows it', () => {
    const w = validateConfig(DEFAULT_CONFIG).filter((i) => i.severity === 'warning');
    expect(w.map((i) => i.field)).toContain('verification.verifierIds');
    expect(isValid(DEFAULT_CONFIG)).toBe(true);
  });

  it('warns about no spare confirmer', () => {
    const c: TriggerConfig = {
      ...DEFAULT_CONFIG,
      verification: { verifierIds: ['ray'], requiredAttestations: 1, policy: 'REQUIRE_ATTESTATION', holdDays: 7 },
    };
    const w = validateConfig(c).filter((i) => i.severity === 'warning');
    expect(w.map((i) => i.message).join(' ')).toMatch(/one more than you need/);
  });

  it('warns about a zero grace period and about absurdly long fuses', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, graceDays: 0 }).map((i) => i.field)).toContain('graceDays');
    expect(validateConfig({ ...DEFAULT_CONFIG, checkInIntervalDays: 900 }).map((i) => i.field))
      .toContain('checkInIntervalDays');
  });
});

describe('timeline preview', () => {
  const T0 = Date.UTC(2026, 0, 1);
  const config: TriggerConfig = {
    ...DEFAULT_CONFIG,
    verification: { ...DEFAULT_CONFIG.verification, verifierIds: ['ray'] },
  };

  it('is chronological and ends with release', () => {
    const events = previewTimeline(config, T0);
    const times = events.map((e) => e.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(events.at(-1)!.kind).toBe('RELEASE');
    expect(events[0]!.kind).toBe('CHECK_IN_DUE');
  });

  it('marks exactly which steps involve other people', () => {
    const events = previewTimeline(config, T0);
    const privateKinds = events.filter((e) => !e.involvesOthers).map((e) => e.kind);
    expect(privateKinds).toContain('CHECK_IN_DUE');
    expect(privateKinds).toContain('GRACE_ENDS');
    expect(privateKinds).toContain('ESCALATION');
    expect(events.find((e) => e.kind === 'RELEASE')!.involvesOthers).toBe(true);
  });

  it('tells the owner their confirmers never see vault contents', () => {
    const asked = previewTimeline(config, T0).find((e) => e.kind === 'VERIFIERS_ASKED')!;
    expect(asked.detail).toMatch(/never shown what is in your vaults/);
    expect(asked.detail).toMatch(/stops all of this/);
  });

  it('omits the confirmer step when nobody is named', () => {
    const events = previewTimeline(DEFAULT_CONFIG, T0);
    expect(events.find((e) => e.kind === 'VERIFIERS_ASKED')).toBeUndefined();
  });

  it('says plainly that release cannot be undone', () => {
    expect(previewTimeline(config, T0).at(-1)!.detail).toMatch(/cannot be undone/);
  });

  it('names channels in words a person would use', () => {
    const esc = previewTimeline(config, T0).filter((e) => e.kind === 'ESCALATION');
    expect(esc[0]!.detail).toMatch(/a notification on your phone and email/);
    expect(esc.at(-1)!.detail).toMatch(/an automated phone call/);
  });

  it('summarises the fuse in one line', () => {
    expect(summariseFuse(DEFAULT_CONFIG)).toMatch(/About 2 months of silence/);
  });
});

describe('humaniseDuration', () => {
  it('reads like a person wrote it', () => {
    expect(humaniseDuration(days(1))).toBe('1 day');
    expect(humaniseDuration(days(9))).toBe('9 days');
    expect(humaniseDuration(days(21))).toBe('3 weeks');
    expect(humaniseDuration(days(63))).toBe('2 months');
    expect(humaniseDuration(days(730))).toBe('2 years');
    expect(humaniseDuration(-1)).toBe('overdue');
  });
});
