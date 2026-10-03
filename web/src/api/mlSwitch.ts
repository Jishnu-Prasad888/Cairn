/**
 * The administrator's machine-learning switch, shared by the whole app.
 *
 * People recognition only exists while this is on, so the sidebar needs to
 * know without every component asking the server. One small store holds the
 * answer: `null` while it is unknown (nothing is hidden on a guess), then
 * true/false. The Machine learning page writes through `updateMLSwitch`, and
 * the sidebar follows immediately.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { getMLSettings, setMLSettings } from './queries';

let value: boolean | null = null;
let started = false;
const listeners = new Set<() => void>();

function publish(next: boolean | null) {
  value = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the switch from the server (once per page load, or when forced). */
export function refreshMLSwitch(force = false): Promise<void> {
  if (started && !force) return Promise.resolve();
  started = true;
  return getMLSettings().then(
    (s) => publish(s.enabled),
    () => {
      // Signed out, or a server without ML routes: leave the answer unknown.
      started = false;
    },
  );
}

/** Turn ML on or off for the whole server (administrators only). */
export async function updateMLSwitch(enabled: boolean): Promise<void> {
  const s = await setMLSettings(enabled);
  publish(s.enabled);
}

/** `true`/`false` once known, `null` before. */
export function useMLSwitch(): boolean | null {
  useEffect(() => {
    void refreshMLSwitch();
  }, []);
  return useSyncExternalStore(subscribe, () => value);
}
