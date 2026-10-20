/**
 * Duplicates — identical files found by content hash.
 *
 * The point of the page is deciding what to do about them, so it decides for
 * the person and lets them adjust: in every group the newest copy is kept and
 * every other copy is selected. Each file can be moved to the trash on its
 * own, and a bar that stays at the top of the page moves everything selected
 * in one go. Trash is reversible, so neither asks first.
 *
 * The old version fetched its own library list and defaulted to
 * `libraries[0]`, which meant a user with two libraries silently saw the wrong
 * one. It now uses the shared selection.
 */

import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/authContext';
import { API_BASE } from '../api/client';
import { useLibraryGate } from '../api/libraries';
import { useLibraryResource } from '../api/resources';
import { listDuplicates, softDeleteFile } from '../api/queries';
import type { DuplicateGroup, FileSummary } from '../api/types';
import { formatBytes } from '../api/types';
import LibraryPicker from '../components/LibraryPicker';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  LoadingState,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import { useToast } from '../components/ui/Toast';
import { formatDate } from '../lib/dates';
import './DuplicatesPage.css';

/** Bytes wasted by keeping every copy except one in a group. */
function redundantBytes(groups: DuplicateGroup[]): number {
  return groups.reduce((sum, g) => sum + g.size_bytes * (g.files.length - 1), 0);
}

/** The copy each group keeps: the most recently modified one. */
function newestOf(files: readonly FileSummary[]): FileSummary | undefined {
  let newest: FileSummary | undefined;
  for (const f of files) {
    if (!newest || Date.parse(f.mod_time) > Date.parse(newest.mod_time)) newest = f;
  }
  return newest;
}

interface MemberProps {
  file: FileSummary;
  kept: boolean;
  selected: boolean;
  busy: boolean;
  onToggle: (file: FileSummary) => void;
  onTrash: (files: FileSummary[]) => void;
}

function DuplicateMember({ file, kept, selected, busy, onToggle, onTrash }: MemberProps) {
  return (
    <li className={selected ? 'dup-member is-selected' : 'dup-member'} data-testid="dup-member">
      <input
        type="checkbox"
        className="dup-member-check"
        checked={selected}
        onChange={() => onToggle(file)}
        aria-label={selected ? `Deselect ${file.name}` : `Select ${file.name}`}
      />
      {file.media_type === 'photo' ? (
        <img
          className="dup-thumb"
          src={`${API_BASE}/libraries/${file.library_id}/files/${file.id}/thumbnail`}
          alt=""
          loading="lazy"
        />
      ) : (
        <span className="dup-thumb dup-thumb-placeholder" aria-hidden="true">
          {file.media_type.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="dup-member-info">
        <span className="dup-member-name">
          {file.name}
          {kept && <span className="dup-member-badge">Newest · kept</span>}
        </span>
        <span className="dup-member-path">
          {file.folder_path || 'Library root'} · {formatDate(file.mod_time)}
        </span>
      </span>
      <span className="dup-member-size">{formatBytes(file.size_bytes)}</span>
      <a
        className="dup-member-action"
        href={`${API_BASE}/libraries/${file.library_id}/files/${file.id}/download`}
      >
        Download
      </a>
      <button
        type="button"
        className="button danger-button dup-member-trash"
        onClick={() => onTrash([file])}
        disabled={busy}
        aria-label={`Move ${file.name} to trash`}
      >
        Move to trash
      </button>
    </li>
  );
}

interface GroupProps {
  group: DuplicateGroup;
  isSelected: (file: FileSummary) => boolean;
  busy: boolean;
  onToggle: (file: FileSummary) => void;
  onTrash: (files: FileSummary[]) => void;
}

function DuplicateGroupCard({ group, isSelected, busy, onToggle, onTrash }: GroupProps) {
  const redundant = group.size_bytes * (group.files.length - 1);
  const keep = newestOf(group.files);
  // The kept copy first, then the others newest-first.
  const ordered = [...group.files].sort((a, b) =>
    a.id === keep?.id
      ? -1
      : b.id === keep?.id
        ? 1
        : Date.parse(b.mod_time) - Date.parse(a.mod_time),
  );
  return (
    <section
      className="dup-group"
      aria-label={`Duplicate group ${group.content_hash.slice(0, 12)}`}
    >
      <header className="dup-group-header">
        <h3>
          {group.files.length} identical files · {formatBytes(group.size_bytes)} each ·{' '}
          {formatBytes(redundant)} redundant
        </h3>
        <code title={group.content_hash}>{group.content_hash.slice(0, 16)}…</code>
      </header>
      <ul className="dup-members">
        {ordered.map((file) => (
          <DuplicateMember
            key={file.id}
            file={file}
            kept={file.id === keep?.id}
            selected={isSelected(file)}
            busy={busy}
            onToggle={onToggle}
            onTrash={onTrash}
          />
        ))}
      </ul>
    </section>
  );
}

export default function DuplicatesPage() {
  const gate = useLibraryGate();
  const { user } = useAuth();
  const [limit, setLimit] = useState(50);
  const toast = useToast();
  // The suggestion (everything but each group's newest copy) is the default;
  // only the person's own ticks and unticks are stored, so groups loaded
  // later with "Show more" arrive already suggested.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  // Files moved to the trash here, hidden at once rather than after a rescan.
  const [trashed, setTrashed] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const duplicates = useLibraryResource<{ total: number; groups: DuplicateGroup[] }>(
    useCallback(
      async (libraryId: string) => {
        const resp = await listDuplicates(libraryId, undefined, limit);
        return { total: resp.total ?? 0, groups: resp.groups ?? [] };
      },
      [limit],
    ),
    [limit],
    true,
    // Finding duplicates groups the whole library by hash: keep the answer
    // across visits instead of redoing it on every return to the page.
    'duplicates',
  );

  const visible = useMemo(
    () =>
      (duplicates.data?.groups ?? [])
        .map((g) => ({ ...g, files: g.files.filter((f) => !trashed.has(f.id)) }))
        .filter((g) => g.files.length > 1),
    [duplicates.data, trashed],
  );

  if (gate.kind === 'loading') {
    return (
      <main className="page duplicates-page">
        <LoadingState label="Loading libraries…" />
      </main>
    );
  }

  const header = (
    <PageHeader
      title="Duplicates"
      subtitle="Files whose contents are byte-for-byte identical, grouped by hash."
      controls={
        <>
          <LibraryPicker />
          <button
            type="button"
            className="button"
            onClick={duplicates.reload}
            disabled={duplicates.loading}
          >
            Rescan
          </button>
        </>
      }
    />
  );

  if (gate.kind === 'error') {
    return (
      <main className="page duplicates-page">
        {header}
        <ErrorState message={gate.message} onRetry={duplicates.reload} />
      </main>
    );
  }

  if (gate.kind === 'empty') {
    return (
      <main className="page duplicates-page">
        {header}
        <NoLibrariesState isAdmin={user?.role === 'admin'} />
      </main>
    );
  }

  const groups = visible;
  const total = Math.max(
    groups.length,
    (duplicates.data?.total ?? 0) - ((duplicates.data?.groups.length ?? 0) - groups.length),
  );
  const keptIds = new Set(groups.map((g) => newestOf(g.files)?.id));
  const isSelected = (file: FileSummary) => overrides.get(file.id) ?? !keptIds.has(file.id);
  const selectedFiles = groups.flatMap((g) => g.files.filter(isSelected));
  const selectedBytes = selectedFiles.reduce((sum, f) => sum + f.size_bytes, 0);

  const toggle = (file: FileSummary) =>
    setOverrides((prev) => new Map(prev).set(file.id, !isSelected(file)));

  const trash = async (files: FileSummary[]) => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    const results = await Promise.allSettled(
      files.map((f) => softDeleteFile(f.library_id || duplicates.libraryId, f.rel_path, f.id)),
    );
    const moved = files.filter((_, i) => results[i]!.status === 'fulfilled');
    setTrashed((prev) => new Set([...prev, ...moved.map((f) => f.id)]));
    setBusy(false);
    const failed = files.length - moved.length;
    toast(
      failed > 0
        ? {
            message: `Moved ${moved.length} of ${files.length} to the trash. The rest could not be moved — they may have changed on disk.`,
            tone: 'error',
          }
        : {
            message: moved.length === 1 ? 'Moved to trash' : `${moved.length} files moved to trash`,
            tone: 'success',
          },
    );
    // Refresh behind the list on screen, so the kept result is current.
    if (moved.length > 0) duplicates.reload();
  };

  return (
    <main className="page duplicates-page">
      {header}
      {gate.library.status === 'offline' && <LibraryOfflineNotice library={gate.library} />}

      {duplicates.error && <ErrorState message={duplicates.error} onRetry={duplicates.reload} />}
      {duplicates.loading && <LoadingState label="Scanning for duplicates…" />}

      {!duplicates.loading && !duplicates.error && groups.length === 0 && (
        <EmptyState title="No duplicates" testId="duplicates-empty">
          <p className="muted">Every file in this library has unique content.</p>
        </EmptyState>
      )}

      {groups.length > 0 && (
        <>
          <div className="dup-actionbar" role="region" aria-label="Selected duplicates">
            <span className="dup-actionbar-count" aria-live="polite">
              {selectedFiles.length === 0
                ? 'Nothing selected'
                : `${selectedFiles.length} selected · ${formatBytes(selectedBytes)}`}
            </span>
            <span className="dup-actionbar-actions">
              <button
                type="button"
                className="button ghost-button"
                onClick={() => setOverrides(new Map())}
                disabled={busy}
              >
                Keep newest only
              </button>
              <button
                type="button"
                className="button ghost-button"
                onClick={() =>
                  setOverrides(new Map(groups.flatMap((g) => g.files.map((f) => [f.id, false]))))
                }
                disabled={busy || selectedFiles.length === 0}
              >
                Clear selection
              </button>
              <button
                type="button"
                className="button danger-button"
                onClick={() => void trash(selectedFiles)}
                disabled={busy || selectedFiles.length === 0}
                data-testid="dup-trash-selected"
              >
                {busy
                  ? 'Moving…'
                  : `Move ${selectedFiles.length > 0 ? selectedFiles.length : ''} to trash`
                      .replace(/\s+/g, ' ')
                      .trim()}
              </button>
            </span>
          </div>
          <p className="duplicates-summary" data-testid="duplicates-summary">
            {total} duplicate {total === 1 ? 'group' : 'groups'} across this library ·{' '}
            {formatBytes(redundantBytes(groups))} redundant
          </p>
          <div className="duplicate-groups">
            {groups.map((group) => (
              <DuplicateGroupCard
                key={group.content_hash}
                group={group}
                isSelected={isSelected}
                busy={busy}
                onToggle={toggle}
                onTrash={(files) => void trash(files)}
              />
            ))}
          </div>
          {total > groups.length && (
            <div className="duplicates-more">
              <button type="button" className="button" onClick={() => setLimit((n) => n + 50)}>
                Show more groups
              </button>
            </div>
          )}
        </>
      )}

      <p className="muted duplicates-footnote">
        Duplicates are computed from the index. Re-run an <Link to="/libraries">index</Link> after
        adding files to pick up new matches.
      </p>
    </main>
  );
}
