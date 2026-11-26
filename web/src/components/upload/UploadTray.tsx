/**
 * The upload tray: present only while there is something to report.
 *
 * Like a cloud drive's upload panel, it opens as a fixed-height card in the
 * corner whose body is a scrollable list with one row per file: its type,
 * name, destination folder, and its own state — a progress ring while it
 * uploads, a check when it lands, and the server's reason when it fails.
 * Collapsed, it is one line and an overall progress bar. It never blocks the
 * page and never covers the bottom navigation.
 */

import { useState } from 'react';

import { formatBytes } from '../../api/types';
import { Icon, type IconName } from '../ui/Icon';
import { type UploadItem, type UploadStatus, useUploads } from './UploadProvider';
import './UploadTray.css';

function summary(items: UploadItem[]) {
  const active = items.filter((i) => i.status === 'queued' || i.status === 'uploading');
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'error').length;
  const total = items.reduce((n, i) => n + (i.status === 'cancelled' ? 0 : i.total), 0);
  const loaded = items.reduce(
    (n, i) => n + (i.status === 'done' ? i.total : i.status === 'cancelled' ? 0 : i.loaded),
    0,
  );
  return { active: active.length, done, failed, fraction: total > 0 ? loaded / total : 0 };
}

function kindIcon(file: File): IconName {
  const type = file.type.split('/')[0];
  if (type === 'image') return 'photo';
  if (type === 'video') return 'video';
  if (type === 'audio') return 'audio';
  return 'file';
}

/** The folder a file is going into, for the row's second line. */
function folderOf(dest: string): string {
  const slash = dest.lastIndexOf('/');
  return slash > 0 ? dest.slice(0, slash) : 'Library root';
}

function percent(item: UploadItem): number {
  return item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : 0;
}

function statusText(item: UploadItem): string {
  switch (item.status) {
    case 'uploading':
      return `${formatBytes(item.loaded)} of ${formatBytes(item.total)} · ${percent(item)}%`;
    case 'queued':
      return `Waiting · ${formatBytes(item.total)}`;
    case 'done':
      return `Uploaded · ${formatBytes(item.total)}`;
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return 'Failed';
  }
}

const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

/** The per-file indicator at the end of a row. */
function StatusMark({ item }: { item: UploadItem }) {
  if (item.status === 'uploading' || item.status === 'queued') {
    const pct = item.status === 'uploading' ? percent(item) : 0;
    return (
      <svg
        className={`upload-ring${item.status === 'queued' ? ' is-waiting' : ''}`}
        viewBox="0 0 24 24"
        width={22}
        height={22}
        role="progressbar"
        aria-label={`${item.file.name} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <circle className="upload-ring-track" cx="12" cy="12" r={RING_R} />
        <circle
          className="upload-ring-fill"
          cx="12"
          cy="12"
          r={RING_R}
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - pct / 100)}
        />
      </svg>
    );
  }
  const icon: Record<Exclude<UploadStatus, 'queued' | 'uploading'>, IconName> = {
    done: 'check',
    error: 'alert',
    cancelled: 'minus',
  };
  return (
    <span className="upload-mark" aria-hidden="true">
      <Icon name={icon[item.status]} size={16} />
    </span>
  );
}

export function UploadTray() {
  const { items, cancel, retry, retryFailed, dismissFinished } = useUploads();
  const [expanded, setExpanded] = useState(true);

  if (items.length === 0) return null;

  const { active, done, failed, fraction } = summary(items);
  const title =
    active > 0
      ? `Uploading ${active} ${active === 1 ? 'file' : 'files'}`
      : failed > 0
        ? `${failed} ${failed === 1 ? 'upload' : 'uploads'} failed`
        : `${done} ${done === 1 ? 'upload' : 'uploads'} complete`;

  // The reason for a failure must not hide behind the collapsed list.
  const firstFailure = items.find((i) => i.status === 'error');
  const failureReason = firstFailure
    ? `${firstFailure.file.name}: ${firstFailure.error ?? 'The upload failed.'}`
    : null;

  return (
    <section
      className={`upload-tray${expanded ? ' is-expanded' : ''}`}
      aria-label="Uploads"
      data-testid="upload-tray"
    >
      <header className="upload-tray-head">
        <div className="upload-tray-title">
          <span className="upload-tray-heading" role="status" aria-live="polite">
            {title}
          </span>
          <span className="upload-tray-sub">
            {done} of {items.length} complete
            {failed > 0 && ` · ${failed} failed`}
          </span>
          {failureReason && !expanded && (
            <span className="upload-tray-sub upload-tray-reason" title={failureReason}>
              {failureReason}
            </span>
          )}
        </div>
        {failed > 0 && (
          <button type="button" className="link-button upload-tray-retry" onClick={retryFailed}>
            Retry failed
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-expanded={expanded}
          aria-controls="upload-tray-list"
          aria-label={expanded ? 'Hide upload details' : 'Show upload details'}
          onClick={() => setExpanded((v) => !v)}
        >
          <Icon name="chevron-down" className={expanded ? undefined : 'is-flipped'} />
        </button>
        {active === 0 && (
          <button
            type="button"
            className="icon-button"
            aria-label="Close uploads"
            onClick={dismissFinished}
          >
            <Icon name="close" />
          </button>
        )}
      </header>

      <div
        className={active > 0 ? 'progress' : 'progress is-complete'}
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <div className="progress-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>

      {expanded && (
        <ul className="upload-tray-list" id="upload-tray-list">
          {items.map((item) => (
            <li key={item.id} className={`upload-item is-${item.status}`}>
              <span className="upload-item-kind" aria-hidden="true">
                <Icon name={kindIcon(item.file)} size={18} />
              </span>
              <div className="upload-item-text">
                <span className="upload-item-name" title={item.dest}>
                  {item.file.name}
                </span>
                <span className="upload-item-status">
                  <span className="upload-item-folder" title={folderOf(item.dest)}>
                    {folderOf(item.dest)}
                  </span>
                  <span aria-hidden="true"> · </span>
                  <span>{statusText(item)}</span>
                </span>
                {item.status === 'error' && (
                  <span className="upload-item-reason">{item.error ?? 'The upload failed.'}</span>
                )}
              </div>
              <StatusMark item={item} />
              {(item.status === 'queued' || item.status === 'uploading') && (
                <button
                  type="button"
                  className="icon-button upload-item-action"
                  aria-label={`Cancel ${item.file.name}`}
                  onClick={() => cancel(item.id)}
                >
                  <Icon name="close" size={18} />
                </button>
              )}
              {(item.status === 'error' || item.status === 'cancelled') && (
                <button
                  type="button"
                  className="icon-button upload-item-action"
                  aria-label={`Retry ${item.file.name}`}
                  onClick={() => retry(item.id)}
                >
                  <Icon name="refresh" size={18} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
