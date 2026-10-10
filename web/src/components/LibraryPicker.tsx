/**
 * The library picker for the page header.
 *
 * This is the control the user reaches for constantly, so it is one component
 * rather than a `<select>` copy-pasted into six pages — and it carries the
 * offline marker, which is the difference between "this library is empty" and
 * "this drive is unplugged".
 *
 * There are two things to choose, so there are two controls: the `<select>`
 * picks which library is *selected* (the one uploads, new folders, and the
 * rest of the single-target actions land in), and the button beside it opens a
 * small panel of checkboxes marking which libraries are *open* — the set whose
 * content every page aggregates. The two stay in step: selecting a library
 * opens it too, and closing the selected one selects the first still open.
 */

import { useEffect, useRef, useState } from 'react';

import { useLibraries } from '../api/libraries';
import { Icon } from './ui/Icon';
import './States.css';
import './LibraryPicker.css';

export default function LibraryPicker({ label = 'Library' }: { label?: string }) {
  const {
    libraries,
    libraryId,
    selectLibrary,
    toggleLibraryOpen,
    openLibraryIds,
    libraryOffline,
  } = useLibraries();
  const [panelOpen, setPanelOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the panel on an outside click or Escape, like a menu.
  useEffect(() => {
    if (!panelOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setPanelOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanelOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [panelOpen]);

  if (libraries.length === 0) return null;
  const open = (id: string) => openLibraryIds.includes(id);

  return (
    <div className="library-picker" ref={rootRef}>
      <select
        aria-label={label}
        value={libraryId ?? ''}
        onChange={(event) => selectLibrary(event.target.value)}
        data-testid="library-picker"
      >
        {libraries.map((lib) => (
          <option key={lib.id} value={lib.id}>
            {lib.name}
            {lib.status === 'offline' ? ' · offline' : ''}
          </option>
        ))}
      </select>

      <div className="library-picker-open">
        <button
          type="button"
          className={panelOpen ? 'button active' : 'button'}
          aria-haspopup="menu"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((v) => !v)}
          data-testid="open-libraries-panel"
        >
          <Icon name="check" />
        </button>

        {panelOpen && (
          <div
            className="library-open-panel"
            role="menu"
            aria-label="Open libraries"
            data-testid="open-libraries-panel-menu"
          >
            <p className="library-open-panel-note">
              Open libraries show merged on every page. Keep at least one open.
            </p>
            <ul>
              {libraries.map((lib) => (
                <li key={lib.id}>
                  <label className="library-open-row">
                    <input
                      type="checkbox"
                      checked={open(lib.id)}
                      disabled={open(lib.id) && openLibraryIds.length <= 1}
                      onChange={() => toggleLibraryOpen(lib.id)}
                      data-testid={`open-library-${lib.id}`}
                    />
                    <span className="library-open-name">
                      {lib.name}
                      {lib.id === libraryId ? (
                        <span className="library-open-selected">selected</span>
                      ) : null}
                    </span>
                    {lib.status === 'offline' && (
                      <span className="status-badge status-badge-offline">Offline</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {libraryOffline && (
        <span className="status-badge status-badge-offline" data-testid="library-picker-offline">
          Offline
        </span>
      )}
    </div>
  );
}