/**
 * Whether moving files to the trash asks first. On until a person ticks
 * "Don't ask again" in the dialog (or turns it off in Settings), and
 * remembered on this device. Deleting forever always asks: only the trash can
 * be undone.
 */

const SKIP_KEY = 'cairn.trash.skipConfirm';

export function readTrashConfirm(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) !== '1';
  } catch {
    return true;
  }
}

export function storeTrashConfirm(confirm: boolean): void {
  try {
    if (confirm) localStorage.removeItem(SKIP_KEY);
    else localStorage.setItem(SKIP_KEY, '1');
  } catch {
    // Not remembered; the dialog just asks again next time.
  }
}
