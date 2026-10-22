/** Helpers shared by the backup settings sections and the Backups page. */

import type { BackupDestination, BackupSettings } from '../../api/types';

/** The saved destination, falling back to `dir` for servers that predate destinations. */
export function savedDestination(settings: BackupSettings): BackupDestination {
  return settings.destination ?? { kind: 'local', path: settings.dir, location: settings.dir };
}

export function destinationConfigured(settings: BackupSettings): boolean {
  const d = savedDestination(settings);
  return d.kind === 'local' ? d.path !== '' : Boolean(d.host);
}

/** Go's zero time marshals as 0001-01-01; treat it (and garbage) as unset. */
export function realDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) || d.getFullYear() < 1971 ? null : d;
}
