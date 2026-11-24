import { useEffect, useRef } from 'react';

import type { FileSummary } from '../../api/types';
import { thumbnailUrl, mediaTypeIcon } from '../media';
import { VideoThumb } from '../media/VideoThumb';
import { Icon } from '../ui/Icon';

/** How many neighbours the filmstrip shows on each side of the open file. */
const FILMSTRIP_REACH = 20;

/**
 * A strip of thumbnails under the stage, so a person can see where they are in
 * the list and jump several files at once. Only the files around the current
 * one are rendered, so a 100k-item library never mounts 100k images.
 */
export function Filmstrip({
  libraryId,
  siblings,
  index,
  onNavigate,
}: {
  /** The library of a sibling that does not name its own. With several
   * libraries open the strip mixes them, and each thumbnail must come from
   * the file's own library — asking the wrong one is a 404 and a blank. */
  libraryId: string;
  siblings: FileSummary[];
  index: number;
  onNavigate: (file: FileSummary) => void;
}) {
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const from = Math.max(0, index - FILMSTRIP_REACH);
  const items = siblings.slice(from, index + FILMSTRIP_REACH + 1);

  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [index]);

  return (
    <ul className="viewer-filmstrip" aria-label="Files in this view">
      {items.map((item) => {
        const current = item.id === siblings[index]?.id;
        return (
          <li key={item.id}>
            <button
              type="button"
              ref={current ? currentRef : undefined}
              className={current ? 'viewer-film active' : 'viewer-film'}
              onClick={() => onNavigate(item)}
              aria-current={current ? 'true' : undefined}
              aria-label={`Open ${item.name}`}
              title={item.name}
            >
              {item.media_type === 'video' ? (
                <VideoThumb libraryId={item.library_id || libraryId} fileId={item.id} />
              ) : item.media_type === 'photo' ? (
                <img src={thumbnailUrl(item.library_id || libraryId, item)} alt="" loading="lazy" />
              ) : (
                <span aria-hidden="true">
                  <Icon name={mediaTypeIcon(item.media_type)} size={18} />
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
