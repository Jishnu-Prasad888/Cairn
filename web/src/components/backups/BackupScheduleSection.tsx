/**
 * When backups run on their own: on a schedule, and when enough new data
 * arrives. The server keeps the schedule's progress, so a slot missed while it
 * was off runs once shortly after it starts again.
 */

import { type FormEvent, useState } from 'react';

import { setBackupSchedule, setBackupTriggers } from '../../api/queries';
import type {
  BackupSchedule,
  BackupScheduleMode,
  BackupSchedulerStatus,
  BackupSettings,
  BackupTriggers,
} from '../../api/types';
import { formatBytes } from '../../api/types';
import { realDate } from './backupSettings';
import './BackupSettings.css';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function savedSchedule(settings: BackupSettings): BackupSchedule {
  if (settings.schedule) return settings.schedule;
  return settings.interval_minutes > 0
    ? { mode: 'interval', interval_minutes: settings.interval_minutes }
    : { mode: 'off' };
}

export function BackupScheduleSection({
  settings,
  status,
  onSaved,
}: {
  settings: BackupSettings;
  status: BackupSchedulerStatus | null;
  onSaved: (next: BackupSettings) => void;
}) {
  const saved = savedSchedule(settings);
  const savedMinutes = saved.interval_minutes ?? 0;
  const [mode, setMode] = useState<BackupScheduleMode>(saved.mode);
  // Whole hours read better; minutes stay available for odd cadences.
  const [unit, setUnit] = useState<'minutes' | 'hours'>(
    savedMinutes > 0 && savedMinutes % 60 !== 0 ? 'minutes' : 'hours',
  );
  const [amount, setAmount] = useState(
    savedMinutes > 0 ? String(savedMinutes % 60 === 0 ? savedMinutes / 60 : savedMinutes) : '24',
  );
  const [time, setTime] = useState(saved.time_of_day ?? '02:00');
  const [weekday, setWeekday] = useState(saved.weekday ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const schedule = (): BackupSchedule => {
    switch (mode) {
      case 'interval':
        return {
          mode,
          interval_minutes: Math.round(Number(amount) * (unit === 'hours' ? 60 : 1)),
        };
      case 'daily':
        return { mode, time_of_day: time };
      case 'weekly':
        return { mode, time_of_day: time, weekday };
      default:
        return { mode: 'off' };
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setBackupSchedule(schedule())
      .then((next) => {
        onSaved(next);
        setNotice('Schedule saved.');
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const next = realDate(status?.next_scheduled_at);
  const retry = realDate(status?.retry_at);

  return (
    <section className="backup-settings-section" aria-labelledby="backup-schedule-title">
      <h2 id="backup-schedule-title">Schedule</h2>
      <form className="backup-inline-form" onSubmit={save}>
        <label className="field">
          <span className="field-label">Run</span>
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as BackupScheduleMode);
              setNotice(null);
            }}
            disabled={busy}
            data-testid="backup-schedule-mode"
          >
            <option value="off">Only when I click Back up now</option>
            <option value="interval">Every…</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
          </select>
        </label>
        {mode === 'interval' && (
          <>
            <label className="field backup-narrow">
              <span className="field-label">Every</span>
              <input
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy}
                data-testid="backup-schedule-amount"
              />
            </label>
            <label className="field">
              <span className="field-label">Unit</span>
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value as 'minutes' | 'hours')}
                disabled={busy}
              >
                <option value="hours">hours</option>
                <option value="minutes">minutes</option>
              </select>
            </label>
          </>
        )}
        {mode === 'weekly' && (
          <label className="field">
            <span className="field-label">On</span>
            <select
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
              disabled={busy}
            >
              {WEEKDAYS.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {(mode === 'daily' || mode === 'weekly') && (
          <label className="field">
            <span className="field-label">At (server time)</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              disabled={busy}
              required
              data-testid="backup-schedule-time"
            />
          </label>
        )}
        <button type="submit" className="button" disabled={busy} data-testid="backup-schedule-save">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
      {status?.waiting ? (
        <p className="muted backups-warning" data-testid="backup-waiting">
          A backup is due but waiting: {status.waiting}.
          {retry ? ` Trying again at ${retry.toLocaleTimeString()}.` : ''}
        </p>
      ) : (
        next && (
          <p className="muted backup-folder-hint" data-testid="backup-next-run">
            Next backup {next.toLocaleString()}. A backup that was missed runs shortly after it was
            due.
          </p>
        )
      )}
      <p className="muted backup-folder-hint">
        If the server is off when a backup is due, it runs once shortly after the server starts
        again, and the schedule carries on from there.
      </p>
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Splits a byte threshold into an editable number and unit. */
function toAmount(bytes: number): { value: string; unit: 'MB' | 'GB' } {
  if (bytes <= 0) return { value: '', unit: 'GB' };
  if (bytes % GB === 0) return { value: String(bytes / GB), unit: 'GB' };
  return { value: String(Math.round((bytes / MB) * 100) / 100), unit: 'MB' };
}

function toBytes(value: string, unit: 'MB' | 'GB'): number {
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * (unit === 'GB' ? GB : MB));
}

function SizeField({
  label,
  value,
  unit,
  onValue,
  onUnit,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  unit: 'MB' | 'GB';
  onValue: (v: string) => void;
  onUnit: (u: 'MB' | 'GB') => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="backup-size-input">
        <input
          type="number"
          min={0}
          step="any"
          value={value}
          placeholder="Off"
          aria-label={label}
          onChange={(e) => onValue(e.target.value)}
          disabled={disabled}
          data-testid={testId}
        />
        <select
          value={unit}
          aria-label={`${label} unit`}
          onChange={(e) => onUnit(e.target.value as 'MB' | 'GB')}
          disabled={disabled}
        >
          <option value="MB">MB</option>
          <option value="GB">GB</option>
        </select>
      </div>
    </div>
  );
}

export function BackupTriggersSection({
  settings,
  status,
  onSaved,
}: {
  settings: BackupSettings;
  status: BackupSchedulerStatus | null;
  onSaved: (next: BackupSettings) => void;
}) {
  const saved: BackupTriggers = settings.triggers ?? { single_file_bytes: 0, total_bytes: 0 };
  const single0 = toAmount(saved.single_file_bytes);
  const total0 = toAmount(saved.total_bytes);
  const [single, setSingle] = useState(single0.value);
  const [singleUnit, setSingleUnit] = useState(single0.unit);
  const [total, setTotal] = useState(total0.value);
  const [totalUnit, setTotalUnit] = useState(total0.unit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setBackupTriggers({
      single_file_bytes: toBytes(single, singleUnit),
      total_bytes: toBytes(total, totalUnit),
    })
      .then((next) => {
        onSaved(next);
        setNotice('Triggers saved.');
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const pending = status?.pending;
  const since = realDate(pending?.since);

  return (
    <section className="backup-settings-section" aria-labelledby="backup-triggers-title">
      <h2 id="backup-triggers-title">Back up when new files arrive</h2>
      <form className="backup-inline-form" onSubmit={save}>
        <SizeField
          label="Any one new file is at least"
          value={single}
          unit={singleUnit}
          onValue={setSingle}
          onUnit={setSingleUnit}
          disabled={busy}
          testId="backup-trigger-single"
        />
        <SizeField
          label="New files add up to at least"
          value={total}
          unit={totalUnit}
          onValue={setTotal}
          onUnit={setTotalUnit}
          disabled={busy}
          testId="backup-trigger-total"
        />
        <button type="submit" className="button" disabled={busy} data-testid="backup-triggers-save">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
      {pending && (
        <p className="muted backup-folder-hint" data-testid="backup-pending">
          {pending.files === 0
            ? since
              ? 'Nothing new since the last backup.'
              : 'Nothing indexed yet.'
            : `${pending.files} new or changed ${pending.files === 1 ? 'file' : 'files'} (${formatBytes(pending.bytes)}, largest ${formatBytes(pending.largest_bytes)}) ${since ? `since the last backup on ${since.toLocaleString()}` : 'not backed up yet'}.`}
        </p>
      )}
      <p className="muted backup-folder-hint">
        Leave a box empty to turn it off. Either one is enough to start a backup between scheduled
        runs. New files are counted once the indexer has seen them; the check runs after every scan.
      </p>
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
