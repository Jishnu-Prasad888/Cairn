/**
 * "Add tag": pick an existing tag, or type a new one, for a set of files.
 *
 * The tags offered are every open library's, merged by name; applying one to
 * a file creates it in that file's library if it is not there yet.
 */

import { type FormEvent, useId, useState } from 'react';

import { useLibraries } from '../api/libraries';
import { tagFiles, tagKey, useTagVocabulary } from '../api/tagVocabulary';
import type { FileSummary } from '../api/types';
import { Dialog } from './Dialog';
import { Icon } from './ui/Icon';

export interface TagPickResult {
  name: string;
  added: number;
  failed: number;
}

export function TagPickerDialog({
  open,
  files,
  onClose,
  onDone,
}: {
  open: boolean;
  files: FileSummary[];
  onClose: () => void;
  onDone: (result: TagPickResult) => void;
}) {
  if (!open) return null;
  return <Picker files={files} onClose={onClose} onDone={onDone} />;
}

function Picker({
  files,
  onClose,
  onDone,
}: {
  files: FileSummary[];
  onClose: () => void;
  onDone: (result: TagPickResult) => void;
}) {
  const { openLibraryIds } = useLibraries();
  const fileLibraries = files.map((f) => f.library_id).filter(Boolean);
  const vocabulary = useTagVocabulary([...new Set([...openLibraryIds, ...fileLibraries])]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();

  const apply = async (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    setBusy(true);
    setError(null);
    try {
      const result = await tagFiles(files, tag);
      if (result.added === 0) {
        setError('The tag could not be added. The library may be offline.');
        return;
      }
      onDone({ name: tag, ...result });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void apply(name);
  };

  const typed = tagKey(name);
  const shown = typed
    ? vocabulary.tags.filter((t) => tagKey(t.name).includes(typed))
    : vocabulary.tags;

  return (
    <Dialog
      open
      title={files.length === 1 ? `Tag “${files[0]!.name}”` : `Tag ${files.length} items`}
      onClose={onClose}
      dismissible={!busy}
      testId="tag-picker-dialog"
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form={`${listId}-form`}
            className="button primary-button"
            disabled={busy || typed === ''}
            data-testid="tag-picker-apply"
          >
            {busy ? 'Adding…' : 'Add tag'}
          </button>
        </>
      }
    >
      <form id={`${listId}-form`} onSubmit={submit}>
        <label className="field">
          <span className="field-label">Tag</span>
          <input
            type="text"
            value={name}
            placeholder="Type a new or existing tag"
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoFocus
            data-testid="tag-picker-input"
          />
        </label>
      </form>
      {shown.length > 0 && (
        <ul className="viewer-tag-suggestions" aria-label="Existing tags">
          {shown.map((t) => (
            <li key={tagKey(t.name)}>
              <button
                type="button"
                className="tag-chip tag-chip-suggestion"
                onClick={() => void apply(t.name)}
                disabled={busy}
                title={`Add tag ${t.name}`}
              >
                <Icon name="tag" size={12} />
                {t.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {vocabulary.tags.length === 0 && !vocabulary.loading && (
        <p className="muted">No tags yet — type a name to create the first one.</p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
