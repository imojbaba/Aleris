/** Milliseconds. All Vigil timestamps are epoch-ms UTC integers. */
export type Millis = number;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const days = (n: number): Millis => Math.round(n * DAY);
export const hours = (n: number): Millis => Math.round(n * HOUR);

/**
 * Human-readable duration for UI and audit logs. Deliberately coarse — nobody
 * making an end-of-life decision needs to read "13 days, 4 hours, 9 minutes".
 */
export function humaniseDuration(ms: Millis): string {
  if (ms < 0) return 'overdue';
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} min`;
  if (ms < DAY) {
    const h = Math.round(ms / HOUR);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = Math.round(ms / DAY);
  if (d < 14) return `${d} day${d === 1 ? '' : 's'}`;
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  if (d < 365) return `${Math.round(d / 30)} months`;
  const y = d / 365;
  return `${y.toFixed(y < 2 ? 1 : 0)} year${y < 1.5 ? '' : 's'}`;
}
