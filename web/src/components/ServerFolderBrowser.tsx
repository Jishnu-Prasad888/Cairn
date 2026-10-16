/**
 * Browsing the server's own folders.
 *
 * Library roots and the backup folder are paths on the machine running Cairn,
 * not on the browser's machine, so a native file dialog cannot pick them. This
 * walks the server's directories one level at a time instead.
 */

import { useEffect, useState } from 'react';

import { browseServerDirs } from '../api/queries';
import type { DirListing } from '../api/queries';
import './ServerFolderBrowser.css';

/** An open-folder glyph for "Browse" buttons. */
export function FolderOpenIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1" />
      <path d="M3.5 19h14a2 2 0 0 0 1.9-1.4l1.6-6A1 1 0 0 0 20 10.4H7a2 2 0 0 0-1.9 1.4L3 19z" />
    </svg>
  );
}

/** Walks the server's folders one level at a time and reports the chosen one. */
export default function ServerFolderBrowser({
  start,
  onChoose,
  onCancel,
}: {
  start: string;
  onChoose: (path: string) => void;
  onCancel: () => void;
}) {
  const [target, setTarget] = useState(start);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [failure, setFailure] = useState<{ target: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    browseServerDirs(target || undefined)
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
  }, [target]);

  return (
    <div className="folder-browser" data-testid="server-folder-browser">
      <div className="folder-browser-bar">
        <button
          type="button"
          className="button"
          onClick={() => listing && setTarget(listing.parent)}
          disabled={!listing || listing.roots}
        >
          ↑ Up
        </button>
        <button
          type="button"
          className="button"
          onClick={() => setTarget('')}
          disabled={!listing || listing.roots}
        >
          Drives
        </button>
        <code className="folder-browser-path" title={listing?.path}>
          {listing ? (listing.roots ? 'Choose a drive or folder' : listing.path) : '…'}
        </code>
      </div>
      <ul className="folder-browser-list">
        {failure && failure.target === target && <li className="error-text">{failure.message}</li>}
        {listing && listing.dirs.length === 0 && <li className="muted">No sub-folders here.</li>}
        {listing?.dirs.map((dir) => (
          <li key={dir.path}>
            <button
              type="button"
              className="folder-browser-item"
              onClick={() => setTarget(dir.path)}
            >
              <span aria-hidden="true">{listing?.roots ? '💽' : '📁'}</span> {dir.name}
            </button>
          </li>
        ))}
      </ul>
      <div className="folder-browser-actions">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary-button"
          onClick={() => listing && onChoose(listing.path)}
          disabled={!listing || listing.roots}
          data-testid="choose-folder"
        >
          Use this folder
        </button>
      </div>
    </div>
  );
}
