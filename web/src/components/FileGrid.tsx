import type { ReactNode } from 'react';

import type { FileSummary } from '../api/types';
import { mediaGlyph, thumbnailUrl } from './media';
import './views.css';

interface FileGridProps {
  libraryId: string;
  files: FileSummary[];
  onOpen: (file: FileSummary) => void;
  /** Optional per-card overlay control, e.g. remove-from-album. */
  renderAction?: (file: FileSummary) => ReactNode;
}

export function FileGrid({ libraryId, files, onOpen, renderAction }: FileGridProps) {
  return (
    <ul className="file-grid" data-testid="file-grid">
      {files.map((f) => (
        <li key={f.id} className="file-card">
          <button type="button" className="file-card-main" onClick={() => onOpen(f)}>
            {f.media_type === 'photo' ? (
              <img
                className="file-card-thumb"
                src={thumbnailUrl(libraryId, f)}
                alt=""
                loading="lazy"
              />
            ) : (
              <span className="file-card-thumb file-card-glyph" aria-hidden="true">
                {mediaGlyph(f)}
              </span>
            )}
            <span className="file-card-name" title={f.rel_path}>
              {f.name}
            </span>
          </button>
          {renderAction?.(f)}
        </li>
      ))}
    </ul>
  );
}
