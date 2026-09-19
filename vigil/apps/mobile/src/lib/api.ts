import { VigilClient } from '@vigil/shared';
import { load, save } from './storage.js';

/**
 * The app's connection to the server, when there is one.
 *
 * Vigil runs in two modes on purpose:
 *
 *   PREVIEW  — no server configured. Everything lives on the device, nothing
 *              is sent, and the time machine stands in for the passage of
 *              months. This is what the shareable build is.
 *   CONNECTED — `EXPO_PUBLIC_API_URL` is set. The device still holds every key
 *              and does every encryption; the server is told the things it
 *              needs in order to run the cascade while the phone is off.
 *
 * The second mode is the product. The first is a way to try it. The split
 * matters because the whole premise is that the trigger fires when the owner
 * is gone — and their phone will be gone with them.
 */

const TOKEN_KEY = 'vigil.session';

interface StoredSession {
  token: string | null;
}

export const apiBaseUrl: string | undefined =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any)?.process?.env?.EXPO_PUBLIC_API_URL || undefined;

export const isConnected = Boolean(apiBaseUrl);

function readToken(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (globalThis as any)?.localStorage?.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredSession).token : null;
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ls = (globalThis as any)?.localStorage;
    if (token === null) ls?.removeItem(TOKEN_KEY);
    else ls?.setItem(TOKEN_KEY, JSON.stringify({ token } satisfies StoredSession));
  } catch {
    // A blocked store must not take the app down.
  }
}

/**
 * The session token, and only the session token, is persisted here.
 *
 * NOT the master key. Signing back in gets you your own ciphertext; opening it
 * still needs the passphrase, which is never stored and never transmitted.
 */
export function createClient(): VigilClient | null {
  if (!apiBaseUrl) return null;
  return new VigilClient({
    baseUrl: apiBaseUrl.replace(/\/$/, ''),
    token: readToken(),
    onToken: writeToken,
  });
}

export { load, save };
