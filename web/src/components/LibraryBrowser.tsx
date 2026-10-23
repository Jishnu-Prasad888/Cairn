/**
 * Walks one library's folders and files so a person can point at one.
 *
 * What can be done with an entry is up to the caller: `actions` renders the
 * buttons for the folder being shown ("here"), and for each folder and file
 * in it. The ignore rules and the machine-learning exclusions both use it.
 */

import { type ReactNode, useEffect, useState } from 'react';

import { browseLibrary } from '../api/queries';
import type { LibraryListing } from '../api/queries';
import type { Library } from '../api/types';
import './ServerFolderBrowser.css';
import './IgnoreRulesDialog.css';

export interface BrowserEntry {
  /** Relative to the library root; '' is the root itself. */
  path: string;
  name: string;
  kind: 'here' | 'dir' | 'file';
}

export function LibraryBrowser({
  library,
  actions,
  onClose,
}: {
  library: Library;
  actions: (entry: BrowserEntry) => ReactNode;
  onClose: () => void;
}) {
  const [target, setTarget] = useState('');
  const [listing, setListing] = useState<LibraryListing | null>(null);
  const [failure, setFailure] = useState<{ target: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    browseLibrary(library.id, target)
      .then((resp) => {
        if (cancelled) return;
        setListing(resp);
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFailure({ target, message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [library.id, target]);

  const atRoot = !listing || listing.path === '';
  const here = listing?.path ?? '';

  return (
    <div className="folder-browser" data-testid="library-browser">
      <div className="folder-browser-bar">
        <button
          type="button"
          className="button"
          onClick={() => listing && setTarget(listing.parent)}
          disabled={atRoot}
        >
          ↑ Up
        </button>
        <code className="folder-browser-path" title={here || library.root}>
          {listing ? `/${here}` : '…'}
        </code>
        {!atRoot && actions({ path: here, name: here.split('/').pop() ?? here, kind: 'here' })}
      </div>
      <ul className="folder-browser-list ignore-browser-list">
        {failure && failure.target === target && <li className="error-text">{failure.message}</li>}
        {listing && listing.dirs.length === 0 && listing.files.length === 0 && (
          <li className="muted">This folder is empty.</li>
        )}
        {listing?.dirs.map((dir) => (
          <li key={dir.path} className="ignore-browser-row">
            <button
              type="button"
              className="folder-browser-item"
              onClick={() => setTarget(dir.path)}
              title={`Open ${dir.name}`}
            >
              <span aria-hidden="true">📁</span> {dir.name}
            </button>
            {actions({ path: dir.path, name: dir.name, kind: 'dir' })}
          </li>
        ))}
        {listing?.files.map((file) => (
          <li key={file.path} className="ignore-browser-row">
            <span className="ignore-browser-file" title={file.path}>
              <span aria-hidden="true">📄</span> {file.name}
            </span>
            {actions({ path: file.path, name: file.name, kind: 'file' })}
          </li>
        ))}
        {listing?.truncated && (
          <li className="muted">Only the first files of this folder are shown.</li>
        )}
      </ul>
      <div className="folder-browser-actions">
        <button type="button" className="button" onClick={onClose}>
          Done browsing
        </button>
      </div>
    </div>
  );
}
