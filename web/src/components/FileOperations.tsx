/**
 * The viewer, plus the dialogs that surround it.
 *
 * Every page that shows a grid of files needs the same thing: open the viewer,
 * and when the viewer asks to rename / move / copy / trash, put an accessible
 * dialog in charge of it and refresh afterwards. That is a hundred lines of
 * identical state per page otherwise — and it was the reason half the pages
 * still called `window.prompt`.
 *
 * Use the hook directly when you need the dialogs without the viewer.
 */

import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';

import { copyFile, deleteForever, moveFile, renameFile, softDeleteFile } from '../api/queries';
import type { FileSummary } from '../api/types';
import { ConfirmDialog, PromptDialog } from './Dialog';
import { FolderPicker } from './FolderPicker';
import type { GridFileAction } from './FileGrid';
import type { ViewerAction } from './ViewerModal';

export type FileDialogKind = ViewerAction | 'permanent';

interface PendingState {
  kind: FileDialogKind;
  file: FileSummary;
}

export interface FileOperations {
  /** The file currently in the viewer, or null. */
  viewer: FileSummary | null;
  openViewer: (file: FileSummary) => void;
  closeViewer: () => void;
  /** Let the viewer (or a page) route a file operation into the dialogs. */
  requestAction: (action: FileDialogKind, file: FileSummary) => void;
  /** Adapter for the FileGrid `onAction` prop — maps GridFileAction to a dialog. */
  onGridAction: (action: GridFileAction, file: FileSummary) => void;
  /** Dialog and error state to render. Renders nothing when idle. */
  dialogs: ReactElement;
  /** True while a dialog action is in flight. */
  busy: boolean;
}

/**
 * Wires the viewer's file operations to real dialogs.
 *
 * @param libraryId the library the files belong to
 * @param onChanged called after any successful mutation, so the caller reloads
 * @param permanent when true the trash dialog runs a permanent delete instead
 *   of a soft delete — that is the Trash page, not the media browser
 */
export function useFileOperations(
  libraryId: string,
  onChanged: () => void,
  { permanent = false }: { permanent?: boolean } = {},
): FileOperations {
  const [viewer, setViewer] = useState<FileSummary | null>(null);
  const [pending, setPending] = useState<PendingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeDialog = useCallback(() => {
    setPending(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (action: () => Promise<unknown>, { closesViewer = false } = {}) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        setPending(null);
        // A trashed file is no longer in the collection the viewer is paging
        // through, so leaving it open would show a ghost.
        if (closesViewer) setViewer(null);
        onChanged();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const requestAction = useCallback(
    (action: FileDialogKind, file: FileSummary) => {
      // On the Trash page a file is already in the trash, so the viewer's
      // "Move to trash" would be a no-op. Offer the action the user actually
      // came there for instead.
      setPending({ kind: permanent && action === 'trash' ? 'permanent' : action, file });
    },
    [permanent],
  );

  // Adapter for FileGrid's onAction prop. 'remove' is album-specific and
  // handled by the page, so we map to a dialog-backed action.
  const onGridAction = useCallback(
    (action: GridFileAction, file: FileSummary) => {
      if (action === 'remove') return; // caller handles album removal separately
      requestAction(action, file);
    },
    [requestAction],
  );

  const dialogs = (
    <>
      <ConfirmDialog
        open={pending?.kind === 'trash' || pending?.kind === 'permanent'}
        title={pending?.kind === 'permanent' ? 'Delete permanently?' : 'Move to trash?'}
        destructive
        confirmLabel={pending?.kind === 'permanent' ? 'Delete forever' : 'Move to trash'}
        busy={busy}
        error={error}
        message={
          pending && (
            <>
              {pending.kind === 'permanent' ? (
                <p>
                  <strong>{pending.file.name}</strong> will be erased from Cairn's index and its
                  bytes deleted from disk. <strong>This cannot be undone.</strong>
                </p>
              ) : (
                <p>
                  <strong>{pending.file.name}</strong> will be moved to the trash. You can restore
                  it from the Trash page.
                </p>
              )}
            </>
          )
        }
        onCancel={closeDialog}
        onConfirm={() => {
          if (!pending) return;
          const target = pending.file;
          const kind = pending.kind;
          void run(
            () =>
              kind === 'permanent'
                ? deleteForever(libraryId, target.id)
                : softDeleteFile(libraryId, target.rel_path, target.id),
            { closesViewer: true },
          );
        }}
        testId="trash-dialog"
      />

      <PromptDialog
        open={pending?.kind === 'rename'}
        title="Rename file"
        label="New name"
        initialValue={pending?.kind === 'rename' ? pending.file.name : ''}
        hint="Only the name changes — the file stays in this folder."
        busy={busy}
        error={error}
        onCancel={closeDialog}
        onConfirm={(name) => {
          if (pending?.kind !== 'rename') return;
          const target = pending.file;
          void run(() => renameFile(libraryId, target.rel_path, target.id, name));
        }}
        testId="rename-dialog"
      />

      <PromptDialog
        open={pending?.kind === 'move'}
        title="Move file"
        label="Destination folder"
        initialValue={pending?.kind === 'move' ? pending.file.folder_path : ''}
        hint="A path relative to the library root. Leave empty to move to the top level."
        control={(field) => (
          <FolderPicker
            libraryId={libraryId}
            value={field.value}
            onChange={field.setValue}
            label="Destination folder"
            placeholder="2024/vacation"
            unavailableNote="Some folders are not listed; type the path to reach one anyway."
            testId="move-destination"
          />
        )}
        busy={busy}
        error={error}
        onCancel={closeDialog}
        onConfirm={(dest) => {
          if (pending?.kind !== 'move') return;
          const target = pending.file;
          void run(() => moveFile(libraryId, target.rel_path, target.id, dest, target.name));
        }}
        testId="move-dialog"
      />

      <PromptDialog
        open={pending?.kind === 'copy'}
        title="Copy file"
        label="Destination folder"
        initialValue={pending?.kind === 'copy' ? pending.file.folder_path : ''}
        hint="A copy is created on disk; the original stays where it is."
        control={(field) => (
          <FolderPicker
            libraryId={libraryId}
            value={field.value}
            onChange={field.setValue}
            label="Destination folder"
            placeholder="archive"
            unavailableNote="Some folders are not listed; type the path to reach one anyway."
            testId="copy-destination"
          />
        )}
        busy={busy}
        error={error}
        onCancel={closeDialog}
        onConfirm={(dest) => {
          if (pending?.kind !== 'copy') return;
          const target = pending.file;
          void run(() => copyFile(libraryId, target.rel_path, target.id, dest, target.name));
        }}
        testId="copy-dialog"
      />
    </>
  );

  return {
    viewer,
    openViewer: setViewer,
    closeViewer: () => setViewer(null),
    requestAction,
    onGridAction,
    dialogs,
    busy,
  };
}
