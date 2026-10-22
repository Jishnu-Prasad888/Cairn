/**
 * Backups — run one, verify one, restore one.
 *
 * Backup policy is server-wide rather than per library, so this page is not
 * library-scoped and has no library picker. It is also admin-only: writing a
 * copy of every library is not something a member should be able to trigger.
 *
 * A backup is metadata, not a download — the bytes live in the destination
 * directory the server chose. The page therefore reports *where* and *how much*
 * rather than pretending to be a file browser, and a backup on the same device
 * as the original is called out, because it is not protection against losing the
 * machine.
 */

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/authContext';
import { useResource } from '../api/resources';
import {
  getBackup,
  getBackupSettings,
  getBackupStatus,
  listBackupDrives,
  listBackups,
  restoreBackup,
  startBackup,
  verifyBackup,
} from '../api/queries';
import type { BackupRecord, BackupSchedulerStatus, BackupSettings } from '../api/types';
import { formatBytes } from '../api/types';
import BackupDestinationSection from '../components/backups/BackupDestinationSection';
import { destinationConfigured } from '../components/backups/backupSettings';
import {
  BackupScheduleSection,
  BackupTriggersSection,
} from '../components/backups/BackupScheduleSection';
import { ConfirmDialog, Dialog, PromptDialog } from '../components/Dialog';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States';
import './BackupsPage.css';

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  completed: 'Completed',
  // Older clients and fixtures used "ok".
  ok: 'Completed',
  failed: 'Failed',
  pruned: 'Pruned',
};

const REASON_LABEL: Record<string, string> = {
  schedule: 'scheduled',
  size: 'new files',
};

/** A backup that finished and can be verified or restored. */
function isDone(record: BackupRecord): boolean {
  return record.status === 'completed' || record.status === 'ok';
}

function StatusBadge({ record }: { record: BackupRecord }) {
  const ok = isDone(record);
  const failed = record.status === 'failed';
  return (
    <span
      className={
        failed
          ? 'status-badge status-badge-offline'
          : ok
            ? 'status-badge status-badge-online'
            : 'status-badge'
      }
      data-testid={`backup-status-${record.id}`}
    >
      {STATUS_LABEL[record.status] ?? record.status}
    </span>
  );
}

function BackupDetailDialog({
  record,
  onClose,
  onRestored,
}: {
  record: BackupRecord;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<BackupRecord | null>(null);
  const [restoring, setRestoring] = useState(false);
  const shown = verified ?? record;

  const verify = () => {
    setBusy(true);
    setError(null);
    verifyBackup(record.id)
      .then(setVerified)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Dialog
        open
        size="medium"
        title={`Backup of ${new Date(shown.started_at).toLocaleString()}`}
        onClose={onClose}
        dismissible={!busy}
        testId="backup-detail-dialog"
        footer={
          <>
            <button
              type="button"
              className="button"
              onClick={verify}
              disabled={busy || !isDone(shown)}
              data-testid="verify-backup"
            >
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button
              type="button"
              className="button primary-button"
              onClick={() => setRestoring(true)}
              disabled={busy || !isDone(shown)}
              data-testid="open-restore-backup"
            >
              Restore…
            </button>
            <button type="button" className="button" onClick={onClose} disabled={busy}>
              Close
            </button>
          </>
        }
      >
        <dl className="backup-detail">
          <div>
            <dt>Destination</dt>
            <dd>
              <code>{shown.destination}</code>
            </dd>
          </div>
          {shown.reason && (
            <div>
              <dt>Started by</dt>
              <dd>
                {shown.reason === 'schedule'
                  ? 'The schedule'
                  : shown.reason === 'size'
                    ? 'New files reaching a size trigger'
                    : 'An administrator'}
              </dd>
            </div>
          )}
          <div>
            <dt>Started</dt>
            <dd>{new Date(shown.started_at).toLocaleString()}</dd>
          </div>
          {shown.finished_at && (
            <div>
              <dt>Finished</dt>
              <dd>{new Date(shown.finished_at).toLocaleString()}</dd>
            </div>
          )}
          <div>
            <dt>Libraries</dt>
            <dd>{shown.libraries}</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>
              {shown.files} copied
              {shown.files_skipped > 0 ? `, ${shown.files_skipped} already present` : ''}
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>
              {formatBytes(shown.bytes)} of media → {formatBytes(shown.stored_bytes)} stored
            </dd>
          </div>
          <div>
            <dt>Encryption</dt>
            <dd>{shown.encrypted ? 'Encrypted at rest' : 'Not encrypted'}</dd>
          </div>
          <div>
            <dt>On the same device</dt>
            <dd>
              {shown.remote
                ? 'No — this is on another server'
                : shown.same_device
                  ? 'Yes — this would not survive losing the machine'
                  : 'No — this is on different storage'}
            </dd>
          </div>
          {shown.verify_status && (
            <div>
              <dt>Verification</dt>
              <dd>
                {shown.verify_status}: {shown.verify_checked} checked, {shown.verify_errors} errors
              </dd>
            </div>
          )}
          {shown.error_msg && (
            <div>
              <dt>Error</dt>
              <dd className="error-text">{shown.error_msg}</dd>
            </div>
          )}
        </dl>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </Dialog>

      {restoring && (
        <PromptDialog
          open
          title="Restore this backup"
          label="Destination directory"
          placeholder="/srv/cairn-restore"
          confirmLabel="Restore"
          hint="Files are written here. Cairn's own libraries are not modified — restore to a new directory and point a library at it."
          busy={busy}
          onCancel={() => setRestoring(false)}
          onConfirm={(destination) => {
            setBusy(true);
            setError(null);
            restoreBackup(record.id, destination)
              .then(() => {
                setRestoring(false);
                onRestored();
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
          testId="restore-backup-dialog"
        />
      )}
    </>
  );
}

export default function BackupsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // `isAdmin` gates the load, not just the render: a member must not fire a
  // request that can only come back 403.
  const backups = useResource(
    useCallback(() => listBackups(), []),
    [],
    isAdmin,
  );
  const settings = useResource(
    useCallback(() => getBackupSettings(), []),
    [],
    isAdmin,
  );
  const [savedSettings, setSavedSettings] = useState<BackupSettings | null>(null);
  const currentSettings = savedSettings ?? settings.data;
  // Status and drives are extras: a server that lacks them (or a failed
  // request) just leaves their lines out.
  const status = useResource(
    useCallback(() => getBackupStatus().catch(() => null), []),
    [],
    isAdmin,
  );
  const drives = useResource(
    useCallback(() => listBackupDrives().catch(() => null), []),
    [],
    isAdmin,
  );
  // Fresh copies fetched while a backup runs, so polling does not flash the
  // loading state.
  const [polled, setPolled] = useState<{
    list: BackupRecord[];
    status: BackupSchedulerStatus | null;
  } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Fetch the single record when a row is opened, so the detail is the
  // server's current view rather than whatever the list was holding.
  const detail = useResource(
    useCallback(() => (detailId ? getBackup(detailId) : Promise.resolve(null)), [detailId]),
    [detailId],
    detailId !== null,
  );

  const list = polled?.list ?? backups.data;
  const schedulerStatus = polled?.status ?? status.data;
  const inProgress =
    Boolean(schedulerStatus?.running) || (list ?? []).some((r) => r.status === 'running');

  // While a backup runs (started here, by the schedule, or by a trigger),
  // refresh the list until it finishes.
  useEffect(() => {
    if (!isAdmin || !inProgress) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      Promise.all([listBackups(), getBackupStatus().catch(() => null)])
        .then(([nextList, nextStatus]) => {
          if (!cancelled) setPolled({ list: nextList, status: nextStatus });
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isAdmin, inProgress]);

  const reloadAll = () => {
    setPolled(null);
    backups.reload();
    status.reload();
  };

  if (!isAdmin) {
    return (
      <main className="page backups-page">
        <PageHeader title="Backups" subtitle="Copies of every library, written by the server." />
        <EmptyState title="Administrators only" testId="backups-forbidden">
          <p className="muted">
            Backups cover every library on this server and are written to a destination the server
            owns, so running them is an administrator action. Ask an administrator if you need one.
          </p>
        </EmptyState>
      </main>
    );
  }

  const run = () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    // Started in the background: a backup to a remote server can take far
    // longer than one request may stay open.
    startBackup()
      .then((rec) => {
        setConfirmRun(false);
        setRunning(false);
        setNotice(
          rec.status === 'running'
            ? `Backup started to ${rec.destination}. This list updates as it runs.`
            : isDone(rec)
              ? `Backed up ${rec.files} files (${formatBytes(rec.stored_bytes)}) to ${rec.destination}.`
              : `Backup finished with status "${rec.status}".`,
        );
        reloadAll();
      })
      .catch((e: unknown) => {
        // The dialog stays open on failure, with the reason inside it, so the
        // run can be retried without re-confirming.
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  };

  const detailRecord = detail.data;
  const latest = list?.[0] ?? null;
  const configured = currentSettings ? destinationConfigured(currentSettings) : true;

  return (
    <main className="page backups-page">
      <PageHeader
        title="Backups"
        subtitle="Copies of every library, written to a destination the server owns. Nothing leaves this machine unless you configure it to."
        controls={
          <button
            type="button"
            className="button primary-button"
            onClick={() => {
              setRunning(true);
              setConfirmRun(true);
            }}
            disabled={running || inProgress || !configured}
            data-testid="run-backup"
          >
            {inProgress ? 'Backing up…' : 'Back up now'}
          </button>
        }
      />

      {/* While the confirm dialog is open it owns the error, so a screen reader
          is not told about the same failure twice. */}
      {error && !confirmRun && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="muted" role="status" data-testid="backup-notice">
          {notice}
        </p>
      )}

      {currentSettings && (
        <div className="backup-settings">
          <BackupDestinationSection
            settings={currentSettings}
            drives={drives.data}
            onSaved={(next) => {
              setSavedSettings(next);
              status.reload();
            }}
          />
          <BackupScheduleSection
            settings={currentSettings}
            status={schedulerStatus}
            onSaved={(next) => {
              setSavedSettings(next);
              status.reload();
            }}
          />
          <BackupTriggersSection
            settings={currentSettings}
            status={schedulerStatus}
            onSaved={setSavedSettings}
          />
          <p className="muted backup-folder-hint">
            Keeps the {currentSettings.keep} most recent backups
            {currentSettings.encrypted ? ', encrypted with the server passphrase' : ''}.
          </p>
        </div>
      )}

      {latest?.same_device && !latest.remote && (
        <p className="muted backups-warning" data-testid="backup-same-device">
          The most recent backup is on the same device as your libraries. It protects against
          accidental deletion, not against losing the machine — point the backup destination at
          separate storage for that.
        </p>
      )}

      {backups.error && <ErrorState message={backups.error} onRetry={backups.reload} />}
      {backups.loading && <LoadingState label="Loading backups…" />}

      {list !== null && list.length === 0 && (
        <EmptyState title="No backups yet" testId="backups-empty">
          <p className="muted">
            Nothing has been backed up. A first run copies every indexed file; later runs skip what
            is already present, so they are quick.
          </p>
        </EmptyState>
      )}

      {list !== null && list.length > 0 && (
        <table className="backup-table" data-testid="backups-table">
          <caption className="visually-hidden">
            Backups with their status, destination, size, and when they ran
          </caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Status</th>
              <th scope="col">Destination</th>
              <th scope="col">Files</th>
              <th scope="col">Stored</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.map((record) => (
              <tr key={record.id} className="backup-row">
                <th scope="row">
                  <time dateTime={record.started_at}>
                    {new Date(record.started_at).toLocaleString()}
                  </time>
                </th>
                <td>
                  <StatusBadge record={record} />
                </td>
                <td className="backup-destination">
                  <code>{record.destination}</code>
                  {record.encrypted && <span className="tag-chip">encrypted</span>}
                  {record.same_device && !record.remote && (
                    <span className="tag-chip">same device</span>
                  )}
                  {record.reason && REASON_LABEL[record.reason] && (
                    <span className="tag-chip">{REASON_LABEL[record.reason]}</span>
                  )}
                </td>
                <td>{record.files}</td>
                <td>{formatBytes(record.stored_bytes)}</td>
                <td>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setDetailId(record.id)}
                    data-testid={`backup-open-${record.id}`}
                  >
                    Details
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detailRecord && (
        <BackupDetailDialog
          record={detailRecord}
          onClose={() => setDetailId(null)}
          onRestored={() => {
            setNotice('Restore started.');
            reloadAll();
            setDetailId(null);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmRun}
        title="Back up every library now?"
        confirmLabel="Back up now"
        busy={busy}
        error={error}
        message={
          <p>
            This copies every indexed file from every library to the configured destination. It runs
            in the background, so you can leave this page; files the last backup already holds are
            not copied again.
          </p>
        }
        onCancel={() => {
          setConfirmRun(false);
          setRunning(false);
        }}
        onConfirm={run}
        testId="run-backup-dialog"
      />
    </main>
  );
}
