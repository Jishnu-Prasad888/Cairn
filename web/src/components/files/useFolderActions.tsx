/**
 * What can be done to a folder, the way a desktop file manager offers it on a
 * right-click — open, open in a new tab, rename, move, download, copy path,
 * delete — plus what Cairn adds: favourite, share, new folder inside, leave
 * out of face recognition, hide from the index.
 *
 * The hook owns the folder favourites (a set, with optimistic toggling), the
 * menu's entries for one folder, and the dialogs the entries open. A page
 * renders `dialogs` once and calls `menuFor` when a folder is right-clicked.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { useAuth } from '../../auth/authContext';
import { useMLSwitch } from '../../api/mlSwitch';
import {
  addMLRules,
  favoriteFolder,
  folderDownloadUrl,
  getIgnoreRules,
  listFavoriteFolders,
  moveFolder,
  saveIgnoreRules,
  trashFolder,
  unfavoriteFolder,
} from '../../api/queries';
import type { Folder } from '../../api/types';
import { ConfirmDialog, PromptDialog } from '../Dialog';
import { FolderPicker } from '../FolderPicker';
import type { MenuEntry } from '../ui/Menu';
import { useToast } from '../ui/Toast';
import { folderFavKey } from './folderDrop';

type Pending = {
  kind: 'rename' | 'move' | 'trash' | 'hide';
  folder: Folder;
  libraryId: string;
} | null;

const parentOf = (path: string) => {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface FolderActions {
  /** Favourite folders, keyed by folderFavKey(library_id, rel_path). */
  favorites: ReadonlySet<string>;
  isFavorite: (folder: Folder) => boolean;
  toggleFavorite: (folder: Folder, libraryId: string) => void;
  menuFor: (folder: Folder) => MenuEntry[];
  /** Move a folder into `destination` (a drag onto a folder or breadcrumb). */
  moveInto: (
    folder: { rel_path: string; name: string },
    libraryId: string,
    destination: string,
  ) => Promise<void>;
  dialogs: ReactElement;
}

/**
 * @param libraryIds the libraries the page shows (for favourites)
 * @param fallbackLibraryId the library of a folder that does not carry one
 * @param onOpen open a folder in this page
 * @param onChanged reload after a folder was renamed, moved or deleted
 * @param onShare open the share dialog for a folder
 * @param onNewFolderIn open the "New folder" dialog inside a folder
 */
export function useFolderActions({
  libraryIds,
  fallbackLibraryId,
  onOpen,
  onChanged,
  onShare,
  onNewFolderIn,
  canManage,
}: {
  libraryIds: readonly string[];
  fallbackLibraryId: string;
  onOpen: (folder: Folder) => void;
  onChanged: () => void;
  onShare?: ((folder: Folder) => void) | undefined;
  onNewFolderIn?: ((folder: Folder) => void) | undefined;
  /** Rename, move and delete are on offer (not on an offline library, say). */
  canManage: boolean;
}): FolderActions {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const mlOn = useMLSwitch() === true;
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const libFor = useCallback(
    (folder: Folder) => folder.library_id || fallbackLibraryId,
    [fallbackLibraryId],
  );

  const key = libraryIds.join(',');
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void Promise.allSettled(
      key
        .split(',')
        .map((lib) =>
          listFavoriteFolders(lib).then((r) =>
            (r.folders ?? []).map((f) => folderFavKey(lib, f.rel_path)),
          ),
        ),
    ).then((results) => {
      if (cancelled) return;
      const next = new Set<string>();
      for (const r of results) if (r.status === 'fulfilled') r.value.forEach((k) => next.add(k));
      setFavorites(next);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const toggleFavorite = useCallback(
    (folder: Folder, libraryId: string) => {
      const k = folderFavKey(libraryId, folder.rel_path);
      const adding = !favorites.has(k);
      const flip = (on: boolean) =>
        setFavorites((prev) => {
          const next = new Set(prev);
          if (on) next.add(k);
          else next.delete(k);
          return next;
        });
      flip(adding);
      (adding ? favoriteFolder : unfavoriteFolder)(libraryId, folder.rel_path)
        .then(() =>
          toast({
            tone: 'success',
            message: adding
              ? `Added “${folder.name}” to favourites`
              : `Removed “${folder.name}” from favourites`,
          }),
        )
        .catch((e: unknown) => {
          flip(!adding);
          toast({ tone: 'error', message: `Couldn’t update favourites: ${errorText(e)}` });
        });
    },
    [favorites, toast],
  );

  const moveInto = useCallback(
    async (folder: { rel_path: string; name: string }, libraryId: string, destination: string) => {
      const target = destination ? `${destination}/${folder.name}` : folder.name;
      if (target === folder.rel_path || parentOf(folder.rel_path) === destination) return;
      if (`${destination}/`.startsWith(`${folder.rel_path}/`)) {
        toast({ tone: 'error', message: 'A folder can’t be moved inside itself.' });
        return;
      }
      try {
        await moveFolder(libraryId, folder.rel_path, target);
        toast({
          tone: 'success',
          message: `Moved “${folder.name}” to ${destination || 'All files'}`,
        });
        onChanged();
      } catch (e: unknown) {
        toast({ tone: 'error', message: `Couldn’t move “${folder.name}”: ${errorText(e)}` });
      }
    },
    [onChanged, toast],
  );

  const copyPath = useCallback(
    (folder: Folder) => {
      const text = folder.rel_path;
      const done = () => toast({ tone: 'success', message: 'Path copied' });
      if (navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(done, () => toast({ tone: 'error', message: 'Couldn’t copy the path' }));
      }
    },
    [toast],
  );

  const menuFor = useCallback(
    (folder: Folder): MenuEntry[] => {
      const lib = libFor(folder);
      const fav = favorites.has(folderFavKey(lib, folder.rel_path));
      const href = `/files?folder=${encodeURIComponent(folder.rel_path)}${
        libraryIds.length > 1 ? `&lib=${encodeURIComponent(lib)}` : ''
      }`;
      const entries: MenuEntry[] = [
        { id: 'open', label: 'Open', icon: 'folder', onSelect: () => onOpen(folder) },
        { id: 'open-tab', label: 'Open in new tab', icon: 'external', href, external: true },
        'separator',
        {
          id: 'favorite',
          label: fav ? 'Remove from favourites' : 'Add to favourites',
          icon: 'star',
          onSelect: () => toggleFavorite(folder, lib),
          testId: 'folder-menu-favorite',
        },
      ];
      if (onShare)
        entries.push({
          id: 'share',
          label: 'Share…',
          icon: 'share',
          onSelect: () => onShare(folder),
        });
      entries.push(
        {
          id: 'download',
          label: 'Download as zip',
          icon: 'download',
          href: folderDownloadUrl(lib, folder.rel_path),
        },
        { id: 'copy-path', label: 'Copy path', icon: 'copy', onSelect: () => copyPath(folder) },
      );
      if (canManage) {
        entries.push('separator');
        if (onNewFolderIn) {
          entries.push({
            id: 'new-folder',
            label: 'New folder inside…',
            icon: 'plus',
            onSelect: () => onNewFolderIn(folder),
          });
        }
        entries.push(
          {
            id: 'rename',
            label: 'Rename…',
            icon: 'edit',
            onSelect: () => setPending({ kind: 'rename', folder, libraryId: lib }),
            testId: 'folder-menu-rename',
          },
          {
            id: 'move',
            label: 'Move to…',
            icon: 'folder-move',
            onSelect: () => setPending({ kind: 'move', folder, libraryId: lib }),
          },
        );
      }
      if (isAdmin) {
        if (mlOn) {
          entries.push({
            id: 'ml-skip',
            label: 'Skip in face recognition',
            icon: 'eye-off',
            onSelect: () => {
              addMLRules(lib, [{ kind: 'skip', path: folder.rel_path }])
                .then(() =>
                  toast({
                    tone: 'success',
                    message: `“${folder.name}” is left out of face recognition and similar photos`,
                  }),
                )
                .catch((e: unknown) => toast({ tone: 'error', message: errorText(e) }));
            },
          });
        }
        entries.push({
          id: 'hide',
          label: 'Hide from Cairn…',
          icon: 'eye-off',
          onSelect: () => setPending({ kind: 'hide', folder, libraryId: lib }),
        });
      }
      if (canManage) {
        entries.push('separator', {
          id: 'trash',
          label: 'Move to trash',
          icon: 'trash',
          danger: true,
          onSelect: () => setPending({ kind: 'trash', folder, libraryId: lib }),
          testId: 'folder-menu-trash',
        });
      }
      return entries;
    },
    [
      libFor,
      favorites,
      libraryIds.length,
      onOpen,
      toggleFavorite,
      onShare,
      copyPath,
      canManage,
      onNewFolderIn,
      isAdmin,
      mlOn,
      toast,
    ],
  );

  const close = () => {
    setPending(null);
    setError(null);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setPending(null);
      onChanged();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const dialogs = (
    <>
      <PromptDialog
        open={pending?.kind === 'rename'}
        title="Rename folder"
        label="New name"
        initialValue={pending?.kind === 'rename' ? pending.folder.name : ''}
        hint="Everything inside keeps its tags, albums and notes."
        busy={busy}
        error={error}
        onCancel={close}
        onConfirm={(name) => {
          if (pending?.kind !== 'rename') return;
          const clean = name.trim().replace(/\//g, '');
          if (!clean || clean === pending.folder.name) return close();
          const parent = parentOf(pending.folder.rel_path);
          const { folder, libraryId } = pending;
          void run(() =>
            moveFolder(libraryId, folder.rel_path, parent ? `${parent}/${clean}` : clean).then(
              () => {},
            ),
          );
        }}
        testId="folder-rename-dialog"
      />

      <PromptDialog
        open={pending?.kind === 'move'}
        title="Move folder"
        label="Destination folder"
        initialValue={pending?.kind === 'move' ? parentOf(pending.folder.rel_path) : ''}
        hint="The folder moves inside the one chosen, with everything in it."
        control={(field) => (
          <FolderPicker
            libraryId={pending?.libraryId ?? fallbackLibraryId}
            value={field.value}
            onChange={field.setValue}
            label="Destination folder"
            placeholder="archive"
            unavailableNote="Some folders are not listed; type the path to reach one anyway."
            testId="folder-move-destination"
          />
        )}
        busy={busy}
        error={error}
        onCancel={close}
        onConfirm={(dest) => {
          if (pending?.kind !== 'move') return;
          const { folder, libraryId } = pending;
          const clean = dest.trim().replace(/^\/+|\/+$/g, '');
          void run(() => moveInto(folder, libraryId, clean));
        }}
        testId="folder-move-dialog"
      />

      <ConfirmDialog
        open={pending?.kind === 'trash'}
        title="Move folder to trash?"
        destructive
        confirmLabel="Move to trash"
        busy={busy}
        error={error}
        message={
          pending?.kind === 'trash' && (
            <p>
              Every file in <strong>{pending.folder.name}</strong>
              {pending.folder.file_count > 0 ? ` (${pending.folder.file_count})` : ''} goes to the
              trash, where each can be restored. The emptied folders are removed.
            </p>
          )
        }
        onCancel={close}
        onConfirm={() => {
          if (pending?.kind !== 'trash') return;
          const { folder, libraryId } = pending;
          void run(async () => {
            const res = await trashFolder(libraryId, folder.rel_path);
            toast({
              tone: res.partial ? 'error' : 'success',
              message: res.partial
                ? `Moved ${res.trashed} files to the trash; some could not be moved`
                : `Moved “${folder.name}” to the trash`,
            });
          });
        }}
        testId="folder-trash-dialog"
      />

      <ConfirmDialog
        open={pending?.kind === 'hide'}
        title="Hide this folder from Cairn?"
        confirmLabel="Hide folder"
        busy={busy}
        error={error}
        message={
          pending?.kind === 'hide' && (
            <p>
              <strong>{pending.folder.name}</strong> stays on disk untouched, but Cairn stops
              indexing it and its files leave every page. Undo it in the library’s ignore rules.
            </p>
          )
        }
        onCancel={close}
        onConfirm={() => {
          if (pending?.kind !== 'hide') return;
          const { folder, libraryId } = pending;
          void run(async () => {
            const { rules } = await getIgnoreRules(libraryId);
            const list = rules ?? [];
            if (!list.some((r) => r.kind === 'path' && r.pattern === folder.rel_path)) {
              await saveIgnoreRules(libraryId, [
                ...list,
                { kind: 'path', pattern: folder.rel_path },
              ]);
            }
            toast({ tone: 'success', message: `“${folder.name}” is hidden from Cairn` });
          });
        }}
        testId="folder-hide-dialog"
      />
    </>
  );

  const isFavorite = useCallback(
    (folder: Folder) => favorites.has(folderFavKey(libFor(folder), folder.rel_path)),
    [favorites, libFor],
  );

  return { favorites, isFavorite, toggleFavorite, menuFor, moveInto, dialogs };
}
