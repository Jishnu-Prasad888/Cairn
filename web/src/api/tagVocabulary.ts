/**
 * Tags across every open library.
 *
 * Each library keeps its own tags in its `.cairn` database, so a tag lives in
 * a library rather than on the server. To the person, though, "family" is one
 * tag: this merges the libraries' tags by name (case-insensitively), and
 * applying a tag to a file creates it in that file's library the first time it
 * is used there.
 *
 * Pages that show tags reload when any of them changes a tag, through a window
 * event, so tagging a file in the viewer shows up on the Tags page and in the
 * filters without a refresh.
 */

import { useEffect, useState } from 'react';

import { ApiError } from './client';
import { addFileTag, createTag, listTags } from './queries';
import type { FileSummary, Tag } from './types';

const CHANGED_EVENT = 'cairn:tags-changed';

/** Tell every tag view that tags or their files changed. */
export function notifyTagsChanged() {
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/** A counter that goes up whenever any view changes tags. */
export function useTagsChangedTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onChanged = () => setTick((t) => t + 1);
    window.addEventListener(CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CHANGED_EVENT, onChanged);
  }, []);
  return tick;
}

/** One tag name, and the tag carrying it in each library that has it. */
export interface SharedTag {
  name: string;
  color?: string | undefined;
  /** The earliest creation across libraries. */
  created_at: string;
  byLibrary: Record<string, Tag>;
}

export const tagKey = (name: string) => name.trim().toLowerCase();

function merge(perLibrary: Array<[string, Tag[]]>): SharedTag[] {
  const byName = new Map<string, SharedTag>();
  for (const [libraryId, tags] of perLibrary) {
    for (const tag of tags) {
      const key = tagKey(tag.name);
      const shared = byName.get(key);
      if (!shared) {
        byName.set(key, {
          name: tag.name,
          color: tag.color,
          created_at: tag.created_at,
          byLibrary: { [libraryId]: tag },
        });
        continue;
      }
      shared.byLibrary[libraryId] = tag;
      shared.color ??= tag.color;
      if (tag.created_at < shared.created_at) shared.created_at = tag.created_at;
    }
  }
  return [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

export interface TagVocabulary {
  tags: SharedTag[];
  /** True until the first load finishes. */
  loading: boolean;
  /** Set only when no library could be read at all. */
  error: string | null;
  reload: () => void;
}

/**
 * Every tag in the given libraries, merged by name. An offline library is
 * skipped rather than failing the whole list.
 */
export function useTagVocabulary(libraryIds: string[], enabled = true): TagVocabulary {
  const [state, setState] = useState<{ key: string; tags: SharedTag[]; error: string | null }>({
    key: '',
    tags: [],
    error: null,
  });
  const [manual, setManual] = useState(0);
  const changed = useTagsChangedTick();
  const tick = manual + changed;
  const idsKey = libraryIds.join('+');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const ids = idsKey ? idsKey.split('+') : [];
    void Promise.allSettled(ids.map((id) => listTags(id))).then((results) => {
      if (cancelled) return;
      const loaded: Array<[string, Tag[]]> = [];
      let firstError: string | null = null;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') loaded.push([ids[i]!, r.value.tags ?? []]);
        else firstError ??= r.reason instanceof Error ? r.reason.message : String(r.reason);
      });
      setState({
        key: `${idsKey}#${tick}`,
        tags: merge(loaded),
        error: loaded.length === 0 && ids.length > 0 ? firstError : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [idsKey, tick, enabled]);

  return {
    tags: state.tags,
    loading: enabled && !state.key.startsWith(`${idsKey}#`),
    error: state.error,
    reload: () => setManual((t) => t + 1),
  };
}

/**
 * The tag with this name in one library, created there if it is missing.
 * `known` is that library's tags when the caller already has them.
 */
export async function ensureTag(libraryId: string, name: string, known?: Tag[]): Promise<Tag> {
  const find = (tags: Tag[]) => tags.find((t) => tagKey(t.name) === tagKey(name));
  const existing = find(known ?? (await listTags(libraryId)).tags ?? []);
  if (existing) return existing;
  try {
    return (await createTag(libraryId, name.trim())).tag;
  } catch (e: unknown) {
    // Someone else created it meanwhile: use theirs.
    if (e instanceof ApiError && e.status === 409) {
      const again = find((await listTags(libraryId)).tags ?? []);
      if (again) return again;
    }
    throw e;
  }
}

/**
 * Apply a tag (by name) to files from any mix of libraries. Returns how many
 * were tagged and how many failed; tag views are told to reload.
 */
export async function tagFiles(
  files: FileSummary[],
  name: string,
  fallbackLibraryId = '',
): Promise<{ added: number; failed: number }> {
  const groups = new Map<string, FileSummary[]>();
  for (const f of files) {
    const lib = f.library_id || fallbackLibraryId;
    groups.set(lib, [...(groups.get(lib) ?? []), f]);
  }
  let added = 0;
  let failed = 0;
  await Promise.all(
    [...groups].map(async ([libraryId, group]) => {
      let tag: Tag;
      try {
        tag = await ensureTag(libraryId, name);
      } catch {
        failed += group.length;
        return;
      }
      const results = await Promise.allSettled(
        group.map((f) => addFileTag(libraryId, f.id, tag.id)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') added += 1;
        else failed += 1;
      }
    }),
  );
  notifyTagsChanged();
  return { added, failed };
}
