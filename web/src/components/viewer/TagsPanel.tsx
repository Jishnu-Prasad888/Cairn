import { type FormEvent, useEffect, useState } from 'react';

import { useLibraries } from '../../api/libraries';
import { addFileTag, listFileTags, listTags, removeFileTag } from '../../api/queries';
import { ensureTag, notifyTagsChanged, tagKey, useTagVocabulary } from '../../api/tagVocabulary';
import type { FileSummary, Tag } from '../../api/types';
import { Icon } from '../ui/Icon';

export function TagsPanel({
  libraryId,
  file,
  onChanged,
}: {
  libraryId: string;
  file: FileSummary;
  onChanged: () => void;
}) {
  const [loaded, setLoaded] = useState<{ library: Tag[]; file: Tag[] } | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumping this re-runs the load; it is the only thing that makes the fetch
  // effect run again, so a reload does not need its own state plumbing.
  const [reloadKey, setReloadKey] = useState(0);
  // Suggestions come from every open library, so a tag made anywhere (the
  // Tags page, another library's file) is offered here too.
  const { openLibraryIds } = useLibraries();
  const vocabulary = useTagVocabulary(
    openLibraryIds.includes(libraryId) ? openLibraryIds : [...openLibraryIds, libraryId],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listTags(libraryId), listFileTags(libraryId, file.id)])
      .then(([all, mine]) => {
        if (cancelled) return;
        setLoaded({ library: all.tags ?? [], file: mine.tags ?? [] });
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, file.id, reloadKey]);

  const libraryTags = loaded?.library ?? [];
  const fileTags = loaded?.file ?? [];
  const onFile = new Set(fileTags.map((t) => tagKey(t.name)));
  const suggestions = vocabulary.tags.filter((t) => !onFile.has(tagKey(t.name)));

  const attachTag = async (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      // Typing a new name creates the tag in this file's library; an existing
      // one is reused.
      const tag = await ensureTag(libraryId, name, libraryTags);
      await addFileTag(libraryId, file.id, tag.id);
      setReloadKey((k) => k + 1);
      notifyTagsChanged();
      setTagInput('');
      onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const detachTag = async (tag: Tag) => {
    setBusy(true);
    setError(null);
    try {
      await removeFileTag(libraryId, file.id, tag.id);
      setReloadKey((k) => k + 1);
      notifyTagsChanged();
      onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void attachTag(tagInput);
  };

  return (
    <div data-testid="viewer-tags">
      {fileTags.length > 0 ? (
        <ul className="viewer-tag-list" data-testid="file-tag-list">
          {fileTags.map((t) => (
            <li key={t.id} className="tag-chip" data-testid={`file-tag-${t.name}`}>
              {t.name}
              <button
                type="button"
                aria-label={`Remove tag ${t.name}`}
                onClick={() => void detachTag(t)}
                disabled={busy}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No tags on this file.</p>
      )}

      <form className="viewer-tag-form" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor={`viewer-tag-input-${file.id}`}>
          Add a tag
        </label>
        <input
          id={`viewer-tag-input-${file.id}`}
          className="viewer-tag-input"
          type="text"
          list={`viewer-tag-suggestions-${file.id}`}
          placeholder="Add tag…"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          disabled={busy}
        />
        <datalist id={`viewer-tag-suggestions-${file.id}`}>
          {suggestions.map((t) => (
            <option key={tagKey(t.name)} value={t.name} />
          ))}
        </datalist>
        <button type="submit" className="button" disabled={busy || tagInput.trim() === ''}>
          Add
        </button>
      </form>

      {suggestions.length > 0 && (
        <ul
          className="viewer-tag-suggestions"
          aria-label="Existing tags"
          data-testid="tag-suggestions"
        >
          {suggestions.map((t) => (
            <li key={tagKey(t.name)}>
              <button
                type="button"
                className="tag-chip tag-chip-suggestion"
                onClick={() => void attachTag(t.name)}
                disabled={busy}
                title={`Add tag ${t.name}`}
              >
                <Icon name="plus" size={12} />
                {t.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
