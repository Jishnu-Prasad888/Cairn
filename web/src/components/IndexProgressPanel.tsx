/**
 * A library's indexing progress, folder by folder.
 *
 * A first scan of a large library takes a while: it lists every folder, then
 * reads and records each file, then queues metadata and a thumbnail for each.
 * Folder views only count what the scan has recorded, so without this a
 * half-scanned library just looks empty in places. The summary says which
 * stage it is in; the tree shows, for every folder, whether the scan has
 * reached it and how much of it is still waiting.
 *
 * Polled every few seconds while anything is moving, rarely otherwise, and not
 * at all while the tab is hidden.
 */

import { useEffect, useMemo, useState } from 'react';

import { getIndexProgress } from '../api/queries';
import type { FolderProgress, FolderProgressStatus, IndexProgress } from '../api/types';
import { Icon } from './ui/Icon';
import './IndexProgressPanel.css';

const ACTIVE_MS = 3000;
const IDLE_MS = 30000;

const numberFormat = new Intl.NumberFormat();
const fmt = (n: number) => numberFormat.format(n);

function busy(p: IndexProgress | null): boolean {
  return p !== null && (p.scan !== undefined || p.scan_queued || p.media_pending > 0);
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 100;
  return Math.min(100, Math.floor((part / whole) * 100));
}

const STATUS_LABEL: Record<FolderProgressStatus, string> = {
  waiting: 'Waiting',
  scanning: 'Scanning',
  processing: 'Processing',
  done: 'Done',
};

/** The share of a folder's current stage that is finished, and what it says. */
function folderStage(f: FolderProgress): { pct: number; detail: string } {
  switch (f.status) {
    case 'waiting':
    case 'scanning':
      return {
        pct: percent(f.scanned, f.files),
        detail: `${fmt(f.scanned)} of ${fmt(f.files)} scanned`,
      };
    case 'processing':
      return {
        pct: percent(f.files - f.media_pending, f.files),
        detail: `${fmt(f.media_pending)} of ${fmt(f.files)} awaiting thumbnails`,
      };
    default:
      return { pct: 100, detail: `${fmt(f.files)} ${f.files === 1 ? 'file' : 'files'}` };
  }
}

/** The folder paths from the root down to path, so the tree opens onto it. */
function ancestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

function FolderRow({
  folder,
  depth,
  expanded,
  onToggle,
  unfinishedOnly,
  current,
}: {
  folder: FolderProgress;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  unfinishedOnly: boolean;
  current: string | undefined;
}) {
  const children = (folder.children ?? []).filter(
    (c) => !unfinishedOnly || c.status !== 'done' || c.media_failed > 0,
  );
  const open = expanded.has(folder.path);
  const { pct, detail } = folderStage(folder);
  const isCurrent = current !== undefined && current === folder.path;

  return (
    <li className="index-tree-item">
      <div
        className={isCurrent ? 'index-tree-row is-current' : 'index-tree-row'}
        style={{ paddingInlineStart: `calc(${depth} * var(--space-4))` }}
        data-testid="index-tree-row"
        data-path={folder.path}
        data-status={folder.status}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="icon-button index-tree-toggle"
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.name}`}
            onClick={() => onToggle(folder.path)}
          >
            <span className={open ? 'index-tree-chevron is-open' : 'index-tree-chevron'}>›</span>
          </button>
        ) : (
          <span className="index-tree-toggle" aria-hidden="true" />
        )}
        <Icon name="folder" size={16} className="index-tree-icon" />
        <span className="index-tree-name" title={folder.path}>
          {folder.name}
        </span>
        <span className={`index-chip index-chip-${folder.status}`}>
          {STATUS_LABEL[folder.status]}
        </span>
        <span className="index-tree-bar" aria-hidden="true">
          <span
            className={`index-tree-fill index-fill-${folder.status}`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="index-tree-pct">{pct}%</span>
        <span className="index-tree-detail muted">
          {detail}
          {folder.media_failed > 0 && (
            <span className="index-tree-failed"> · {fmt(folder.media_failed)} failed</span>
          )}
        </span>
      </div>
      {open && children.length > 0 && (
        <ul className="index-tree">
          {children.map((c) => (
            <FolderRow
              key={c.path}
              folder={c}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              unfinishedOnly={unfinishedOnly}
              current={current}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function Summary({ progress }: { progress: IndexProgress }) {
  const { scan } = progress;
  const lines: React.ReactNode[] = [];
  let pct: number | null = null;

  if (scan?.phase === 'counting') {
    lines.push('Counting the files in every folder…');
  } else if (scan) {
    pct = percent(scan.files_scanned, scan.files_total);
    lines.push(
      <>
        Scanning {fmt(scan.files_scanned)} of {fmt(scan.files_total)} files ({pct}%)
        {scan.current_folder && (
          <>
            {' '}
            · now in <code>{scan.current_folder}</code>
          </>
        )}
      </>,
    );
  } else if (progress.scan_queued) {
    lines.push('A scan is queued and will start shortly.');
  }

  if (progress.media_pending > 0) {
    lines.push(`${fmt(progress.media_pending)} files waiting for metadata and thumbnails.`);
  }
  if (progress.media_failed > 0) {
    lines.push(`${fmt(progress.media_failed)} files could not be processed.`);
  }
  if (lines.length === 0) {
    lines.push(`All ${fmt(progress.root.files)} files are indexed.`);
  }

  return (
    <div className="index-summary" data-testid="index-summary">
      {lines.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
      {pct !== null && (
        <div
          className="index-summary-bar"
          role="progressbar"
          aria-label="Scan progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export function IndexProgressPanel({ libraryId, name }: { libraryId: string; name: string }) {
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [failed, setFailed] = useState(false);
  const [showTree, setShowTree] = useState(false);
  const [unfinishedOnly, setUnfinishedOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: IndexProgress | null = null;

    const tick = () => {
      if (cancelled) return;
      if (document.hidden) {
        timer = setTimeout(tick, IDLE_MS);
        return;
      }
      getIndexProgress(libraryId)
        .then((resp) => {
          if (cancelled) return;
          const folder = resp.progress.scan?.current_folder;
          // Open the tree onto the folder being scanned whenever the scan
          // moves on, without closing anything the person opened.
          if (folder && folder !== last?.scan?.current_folder) {
            const want = ['', ...ancestors(folder).slice(0, -1)];
            setExpanded((prev) =>
              want.every((p) => prev.has(p)) ? prev : new Set([...prev, ...want]),
            );
          }
          last = resp.progress;
          setProgress(resp.progress);
          setFailed(false);
          timer = setTimeout(tick, busy(last) ? ACTIVE_MS : IDLE_MS);
        })
        .catch(() => {
          if (cancelled) return;
          setFailed(true);
          timer = setTimeout(tick, IDLE_MS);
        });
    };
    tick();
    const onVisible = () => {
      if (!document.hidden) {
        if (timer) clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [libraryId]);

  const current = progress?.scan?.current_folder;

  const root = useMemo<FolderProgress | null>(
    () => (progress ? { ...progress.root, name } : null),
    [progress, name],
  );

  if (!progress || !root) {
    return failed ? (
      <p className="muted index-progress-error">Indexing progress is unavailable.</p>
    ) : null;
  }

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <section className="index-progress" aria-label={`Indexing progress of ${name}`}>
      <Summary progress={progress} />
      <div className="index-progress-controls">
        <button
          type="button"
          className="button index-progress-toggle"
          aria-expanded={showTree}
          onClick={() => setShowTree((v) => !v)}
          data-testid="index-tree-toggle"
        >
          <Icon name="folder" size={16} />
          {showTree ? 'Hide folders' : 'Show folders'}
        </button>
        {showTree && (
          <label className="index-progress-filter">
            <input
              type="checkbox"
              checked={unfinishedOnly}
              onChange={(e) => setUnfinishedOnly(e.target.checked)}
            />
            Only unfinished
          </label>
        )}
      </div>
      {showTree && (
        <ul className="index-tree index-tree-root" data-testid="index-tree">
          <FolderRow
            folder={root}
            depth={0}
            expanded={expanded}
            onToggle={toggle}
            unfinishedOnly={unfinishedOnly}
            current={current}
          />
        </ul>
      )}
    </section>
  );
}
