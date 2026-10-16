/**
 * Tags — the tag vocabulary of every open library and the files that carry
 * each tag. Tags are stored per library (in its `.cairn` folder) but shown
 * merged by name, so one "family" tag spans all open libraries.
 *
 * Tags are a flat, colourable vocabulary; the interesting part is the second
 * screen, where you see everything carrying a tag and can strip it from
 * individual files. Both screens use the shared library gate, the shared
 * dialogs, and the shared viewer, so nothing here reimplements them.
 */

import { useCallback, useState } from 'react';

import { useAuth } from '../auth/authContext';
import { useLibraryGate } from '../api/libraries';
import { useResource } from '../api/resources';
import { ApiError } from '../api/client';
import { createTag, deleteTag, removeFileTag, searchFiles } from '../api/queries';
import {
  type SharedTag,
  notifyTagsChanged,
  tagKey,
  useTagsChangedTick,
  useTagVocabulary,
} from '../api/tagVocabulary';
import type { FileSummary } from '../api/types';
import { ConfirmDialog, PromptDialog } from '../components/Dialog';
import { MediaGrid } from '../components/media/MediaGrid';
import { SelectionToolbar } from '../components/media/SelectionToolbar';
import { useMediaActions } from '../components/media/useMediaActions';
import { useSelection } from '../components/media/useSelection';
import { useFileOperations } from '../components/FileOperations';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  LoadingState,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import { Menu, type MenuAnchor, type MenuEntry } from '../components/ui/Menu';
import { ViewerModal } from '../components/ViewerModal';
import './TagsPage.css';

export default function TagsPage() {
  const gate = useLibraryGate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [activeName, setActiveName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<SharedTag | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuEntry[] } | null>(null);

  const libraryIds = gate.kind === 'ready' ? gate.openLibraryIds : NO_IDS;
  const vocabulary = useTagVocabulary(libraryIds, gate.kind === 'ready');
  const tags = {
    data: vocabulary.loading ? null : vocabulary.tags,
    loading: vocabulary.loading,
    error: vocabulary.error,
    reload: vocabulary.reload,
  };
  const activeTag =
    activeName === null
      ? null
      : (vocabulary.tags.find((t) => tagKey(t.name) === tagKey(activeName)) ?? null);
  const changed = useTagsChangedTick();

  // Files carrying the tag, from every library that has it.
  const files = useResource(
    useCallback(async () => {
      if (!activeTag) return [];
      const ids = Object.keys(activeTag.byLibrary);
      const results = await Promise.allSettled(
        ids.map((id) => searchFiles(id, { tag: activeTag.name, limit: 200 })),
      );
      const ok = results.flatMap((r) => (r.status === 'fulfilled' ? (r.value.files ?? []) : []));
      const failed = results.find((r) => r.status === 'rejected');
      if (ok.length === 0 && failed?.status === 'rejected') throw failed.reason;
      return ok.sort((a, b) => b.mod_time.localeCompare(a.mod_time));
    }, [activeTag]),
    [activeTag?.name, Object.keys(activeTag?.byLibrary ?? {}).join('+'), changed],
    activeTag !== null,
  );

  const ops = useFileOperations(libraryIds, () => {
    files.reload();
    tags.reload();
  });
  const tagFiles = files.data ?? NO_FILES;
  const selection = useSelection(tagFiles, activeTag ? tagKey(activeTag.name) : '');
  const libraryIdOrEmpty = gate.kind === 'ready' ? gate.libraryId : '';
  const untag = async (targets: FileSummary[]) => {
    if (!activeTag) return;
    await run(() =>
      Promise.all(
        targets.map((f) => {
          const lib = f.library_id || libraryIdOrEmpty;
          const tag = activeTag.byLibrary[lib];
          return tag ? removeFileTag(lib, f.id, tag.id) : Promise.resolve();
        }),
      ),
    );
    selection.clear();
  };
  const actions = useMediaActions({
    libraryId: libraryIdOrEmpty,
    selection,
    ops,
    onChanged: files.reload,
    extra: activeTag
      ? [
          {
            id: 'untag',
            label: `Remove tag “${activeTag.name}”`,
            icon: 'tag',
            onClick: () => void untag(selection.selectedFiles),
            testId: 'selection-untag',
          },
        ]
      : [],
  });

  const run = useCallback(async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      after?.();
      notifyTagsChanged();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  if (gate.kind === 'loading') {
    return (
      <main className="page tags-page">
        <LoadingState label="Loading libraries…" />
      </main>
    );
  }

  const header = (
    <PageHeader
      title="Tags"
      subtitle="A flat vocabulary you apply to any file, from the viewer or in bulk."
      controls={
        <>
          <button
            type="button"
            className="button primary-button"
            onClick={() => {
              setPromptError(null);
              setCreating(true);
            }}
            disabled={gate.kind !== 'ready'}
            data-testid="new-tag-button"
          >
            New tag
          </button>
        </>
      }
    />
  );

  if (gate.kind === 'error') {
    return (
      <main className="page tags-page">
        {header}
        <ErrorState message={gate.message} onRetry={tags.reload} />
      </main>
    );
  }

  if (gate.kind === 'empty') {
    return (
      <main className="page tags-page">
        {header}
        <NoLibrariesState isAdmin={isAdmin} />
      </main>
    );
  }

  const library = gate.library;
  const offline = library.status === 'offline';

  return (
    <main className="page tags-page">
      {header}

      {offline && <LibraryOfflineNotice library={library} />}
      {actionError && (
        <p className="error-text" role="alert">
          {actionError}
        </p>
      )}

      {tags.error && <ErrorState message={tags.error} onRetry={tags.reload} />}

      {activeTag ? (
        <section className="tag-detail" data-testid="tag-detail">
          <div className="tag-detail-header">
            <button type="button" className="button" onClick={() => setActiveName(null)}>
              ← Tags
            </button>
            <h2>
              <span className="tag-chip">{activeTag.name}</span>
            </h2>
            <button
              type="button"
              className="button danger-button"
              onClick={() => setDeleting(activeTag)}
            >
              Delete tag
            </button>
          </div>

          {files.loading && <LoadingState />}
          {files.error && <ErrorState message={files.error} onRetry={files.reload} />}

          {files.data !== null && files.data.length === 0 && (
            <EmptyState title="Nothing tagged yet" testId="tag-files-empty">
              <p className="muted">No files carry this tag. Add it from the file viewer.</p>
            </EmptyState>
          )}

          {files.data !== null && files.data.length > 0 && (
            <MediaGrid
              libraryId={gate.libraryId}
              files={files.data}
              onOpen={ops.openViewer}
              selection={selection}
              onContextMenu={(file, x, y) =>
                setMenu({ anchor: { x, y }, items: actions.menuFor(file) })
              }
              label={`Tagged ${activeTag.name}`}
              testId="file-grid"
            />
          )}

          {ops.viewer && (
            <ViewerModal
              libraryId={ops.viewerLibraryId}
              file={ops.viewer}
              siblings={files.data ?? []}
              onNavigate={ops.openViewer}
              onChanged={notifyTagsChanged}
              onRequestAction={ops.requestAction}
              onClose={ops.closeViewer}
            />
          )}
          {menu && (
            <Menu
              anchor={menu.anchor}
              items={menu.items}
              onClose={() => setMenu(null)}
              label="Photo actions"
            />
          )}
          {ops.dialogs}
          {actions.dialogs}
          {selection.active && (
            <SelectionToolbar
              count={selection.size}
              total={tagFiles.length}
              actions={actions.selectionActions}
              onClear={selection.clear}
              onSelectAll={selection.selectAll}
              onDeleteKey={actions.onDeleteKey}
            />
          )}
        </section>
      ) : (
        <>
          {tags.loading && <LoadingState />}
          {tags.data !== null && tags.data.length === 0 && (
            <EmptyState title="No tags yet" testId="tags-empty">
              <p className="muted">
                Tags are how you label media across folders. Create one, then apply it from the
                viewer.
              </p>
            </EmptyState>
          )}
          {tags.data !== null && tags.data.length > 0 && (
            <ul className="tag-grid" data-testid="tags-grid" aria-label="Tags">
              {tags.data.map((tag) => (
                <li key={tagKey(tag.name)}>
                  <button
                    type="button"
                    className="tag-card"
                    onClick={() => setActiveName(tag.name)}
                  >
                    <span
                      className="tag-chip"
                      style={tag.color ? { background: tag.color } : undefined}
                    >
                      {tag.name}
                    </span>
                    <span className="tag-date">
                      Created {new Date(tag.created_at).toLocaleDateString()}
                      {libraryIds.length > 1 &&
                        ` · in ${Object.keys(tag.byLibrary).length} of ${libraryIds.length} libraries`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <PromptDialog
        open={creating}
        title="New tag"
        label="Tag name"
        placeholder="family"
        hint="The tag is added to every open library. Typing an existing name in the viewer reuses it."
        busy={busy}
        error={promptError}
        onCancel={() => setCreating(false)}
        onConfirm={(name) => {
          setBusy(true);
          setPromptError(null);
          // Each library stores its own tags, so the new tag is created in every
          // open one; a library that already has it is fine.
          void Promise.allSettled(libraryIds.map((id) => createTag(id, name.trim())))
            .then((results) => {
              // Created in at least one library: done. Otherwise every
              // library refused it — already there, or offline — so say why.
              if (results.some((r) => r.status === 'fulfilled')) {
                setCreating(false);
                notifyTagsChanged();
                return;
              }
              const reasons = results.map((r) => (r.status === 'rejected' ? r.reason : null));
              const reason: unknown =
                reasons.find((e) => !(e instanceof ApiError && e.status === 409)) ?? reasons[0];
              setPromptError(
                reason instanceof Error ? reason.message : 'Could not create the tag.',
              );
            })
            .finally(() => setBusy(false));
        }}
        testId="new-tag-dialog"
      />

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete tag “${deleting?.name ?? ''}”?`}
        destructive
        confirmLabel="Delete tag"
        busy={busy}
        error={actionError}
        message={
          <p>
            The tag is removed from every file that carries it. The files themselves are not
            affected.
          </p>
        }
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          const target = deleting;
          void run(
            () =>
              Promise.all(
                Object.entries(target.byLibrary).map(([lib, tag]) => deleteTag(lib, tag.id)),
              ),
            () => {
              setActiveName(null);
              setDeleting(null);
            },
          );
        }}
        testId="delete-tag-dialog"
      />
    </main>
  );
}

const NO_FILES: FileSummary[] = [];
const NO_IDS: string[] = [];
