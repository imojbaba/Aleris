/**
 * Persistence.
 *
 * On web this is localStorage; on a device it would be AsyncStorage or, for
 * anything sensitive, expo-secure-store. Only ciphertext and the wrapped
 * identity are ever written — the master key lives in memory for the session
 * and nowhere else, which is why reopening the app asks for the passphrase
 * again. That is the design working, not an oversight.
 */

const KEY = 'vigil.v1';

function backing(): Storage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

export function load<T>(): T | null {
  try {
    const raw = backing()?.getItem(KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function save<T>(value: T): void {
  try {
    backing()?.setItem(KEY, JSON.stringify(value));
  } catch {
    // A full or blocked store must never take the app down.
  }
}

export function clear(): void {
  try {
    backing()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
