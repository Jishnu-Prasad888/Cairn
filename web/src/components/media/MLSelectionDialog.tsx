/**
 * Skip selected photos in machine learning, or always include them.
 *
 * Opened from the selection toolbar. Each photo becomes a rule on its own
 * library (selections can span several), replacing any rule already on it.
 * Folders are chosen on the Machine learning page.
 */

import { useState } from 'react';

import { addMLRules, type MLRule } from '../../api/queries';
import type { FileSummary } from '../../api/types';
import { Dialog } from '../Dialog';

export function MLSelectionDialog({
  files,
  fallbackLibraryId,
  onClose,
  onDone,
}: {
  files: FileSummary[] | null;
  fallbackLibraryId: string;
  onClose: () => void;
  onDone: (kind: MLRule['kind'], count: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photos = (files ?? []).filter((f) => f.media_type === 'photo');
  const n = photos.length;
  const these = n === 1 ? 'this photo' : `these ${n} photos`;

  const apply = async (kind: MLRule['kind']) => {
    setBusy(true);
    setError(null);
    const byLibrary = new Map<string, MLRule[]>();
    for (const f of photos) {
      const lib = f.library_id || fallbackLibraryId;
      byLibrary.set(lib, [...(byLibrary.get(lib) ?? []), { kind, path: f.rel_path }]);
    }
    try {
      for (const [lib, rules] of byLibrary) await addMLRules(lib, rules);
      onDone(kind, n);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setError(null);
    onClose();
  };

  return (
    <Dialog
      open={files !== null}
      title="Face recognition and similar images"
      onClose={close}
      dismissible={!busy}
      testId="ml-selection-dialog"
      footer={
        <>
          <button type="button" className="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void apply('always')}
            disabled={busy || n === 0}
          >
            Always include
          </button>
          <button
            type="button"
            className="button primary-button"
            onClick={() => void apply('skip')}
            disabled={busy || n === 0}
          >
            {busy ? 'Saving…' : 'Skip'}
          </button>
        </>
      }
    >
      <div className="dialog-message">
        {n === 0 ? (
          <p>Only photos are analysed, and none are selected.</p>
        ) : (
          <>
            <p>
              <strong>Skip</strong> leaves {these} out of face recognition and similar images; faces
              already found in {n === 1 ? 'it' : 'them'} are discarded.
            </p>
            <p>
              <strong>Always include</strong> analyses {these} fully, even inside a skipped folder
              or with more faces than the crowd limit.
            </p>
            {files && files.length > n && (
              <p>
                {files.length - n} selected {files.length - n === 1 ? 'item is' : 'items are'} not a
                photo and {files.length - n === 1 ? 'is' : 'are'} left as{' '}
                {files.length - n === 1 ? 'it is' : 'they are'}.
              </p>
            )}
          </>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
