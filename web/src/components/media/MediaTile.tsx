/**
 * One square in the media grid.
 *
 * The image is the tile: there is no card around it. Controls appear only
 * when they are useful — the selection circle and caption on hover or focus,
 * or for every tile while a selection is in progress — and a favorite or a
 * video is marked with a small badge that never covers the subject.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent } from 'react';

import type { FileSummary } from '../../api/types';
import { LibraryTag } from '../LibraryTag';
import { Icon } from '../ui/Icon';
import { thumbnailUrl, mediaTypeIcon } from '../media';
import { thumbBatchingEnabled, thumbSizeFor, useBatchedThumb } from './thumbBatch';
import { useQueuedImage } from './thumbnailQueue';
import { VideoThumb } from './VideoThumb';

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;
/** Waits before asking again for a thumbnail that failed to load. A failure
 * is often passing — the server busy making it, or a dropped connection — so
 * the tile tries again before settling on the broken-image glyph. */
const THUMB_RETRY_MS = [2000, 8000];

/** One thumbnail URL's loading state: retries made, and whether the tile is
 * loading it, waiting to retry, or has given up. */
interface ThumbAttempt {
  url: string | undefined;
  retries: number;
  phase: 'loading' | 'waiting' | 'failed';
}

/** The small thumbnail is the same URL with `size=sm`. */
function sized(url: string, size: 'sm' | 'md'): string {
  return size === 'sm' ? `${url}${url.includes('?') ? '&' : '?'}size=sm` : url;
}

/** A retry is a distinct URL, so the browser asks the server again and the
 * download queue gives it a fresh turn. */
function withRetry(url: string, retries: number): string {
  return retries === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}retry=${retries}`;
}

export interface MediaTileProps {
  libraryId: string;
  file: FileSummary;
  index: number;
  /** Position and size in the grid, in px. Plain numbers rather than a style
   * object so `memo` can skip a tile whose place did not change — scrolling
   * re-renders the grid every few rows, and only new tiles should pay. */
  top: number;
  left: number;
  width: number;
  height: number;
  selected: boolean;
  selectable: boolean;
  /** A selection is in progress: the check is always shown. */
  selecting: boolean;
  favorite: boolean;
  /** Roving tab stop: only one tile in the grid is in the Tab order. */
  tabbable: boolean;
  onActivate: (file: FileSummary, index: number, event: ReactMouseEvent) => void;
  onToggleSelect: (file: FileSummary, index: number, range: boolean) => void;
  /** A touch long-press; selects the tile (and may start a drag-select). */
  onLongPress?: ((file: FileSummary, index: number) => void) | undefined;
  onFocusTile: (index: number) => void;
  onContextMenu?: ((file: FileSummary, x: number, y: number) => void) | undefined;
}

function MediaTileImpl({
  libraryId,
  file,
  index,
  top,
  left,
  width,
  height,
  selected,
  selectable,
  selecting,
  favorite,
  tabbable,
  onActivate,
  onToggleSelect,
  onLongPress,
  onFocusTile,
  onContextMenu,
}: MediaTileProps) {
  const [thumbState, setThumbState] = useState<ThumbAttempt | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longPressed = useRef(false);

  const isVideo = file.media_type === 'video';
  // The file belongs to a specific library; the tile always renders for it,
  // even when the grid merged several libraries.
  const itemLibraryId = file.library_id || libraryId;
  // Small tiles get the 256px thumbnail: a quarter of the bytes.
  const size = thumbSizeFor(Math.max(width, height));
  const isPhoto = file.media_type === 'photo';
  // Photos come through the batcher first (many per request, kept on the
  // device); one it cannot supply loads on its own below, retries and all.
  const [batchBroken, setBatchBroken] = useState(false);
  const batched = useBatchedThumb(
    itemLibraryId,
    file,
    size,
    isPhoto && !batchBroken && thumbBatchingEnabled(),
  );
  const single = batched.missing;
  const photoUrl = isPhoto ? sized(thumbnailUrl(itemLibraryId, file), size) : undefined;
  // A new URL (the file changed) starts over.
  const thumb: ThumbAttempt =
    thumbState && thumbState.url === photoUrl
      ? thumbState
      : { url: photoUrl, retries: 0, phase: 'loading' };
  const failed = thumb.phase === 'failed';
  const hasThumb = (file.media_type === 'photo' || isVideo) && !failed;
  const {
    src: thumbSrc,
    attach: attachThumb,
    settle: settleThumb,
  } = useQueuedImage(
    single && photoUrl !== undefined && thumb.phase === 'loading'
      ? withRetry(photoUrl, thumb.retries)
      : undefined,
  );
  const attachBatched = batched.attach;
  const attachImage = useCallback(
    (el: HTMLImageElement | null) => {
      attachThumb(el);
      attachBatched(el);
    },
    [attachThumb, attachBatched],
  );
  // While a zoom swaps the thumbnail size, keep the old picture up until the
  // new one is here rather than flashing the tile empty.
  const freshSrc = batched.src ?? thumbSrc;
  const [lastSrc, setLastSrc] = useState(freshSrc);
  if (freshSrc && freshSrc !== lastSrc) setLastSrc(freshSrc);
  // Only while the batcher fetches the new size: a failed single download
  // must clear, so its retry (or the broken glyph) shows.
  const shownSrc = freshSrc ?? (single ? undefined : lastSrc);

  useEffect(() => {
    if (thumbState?.phase !== 'waiting' || thumbState.url !== photoUrl) return;
    const timer = setTimeout(
      () => setThumbState({ ...thumbState, retries: thumbState.retries + 1, phase: 'loading' }),
      THUMB_RETRY_MS[thumbState.retries],
    );
    return () => clearTimeout(timer);
  }, [thumbState, photoUrl]);

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  // Touch has no hover and no modifier keys, so a long press is how a phone
  // starts a selection.
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !selectable) return;
    longPressed.current = false;
    const { clientX: x, clientY: y } = event;
    press.current = {
      x,
      y,
      timer: setTimeout(() => {
        longPressed.current = true;
        press.current = null;
        navigator.vibrate?.(10);
        if (onLongPress) onLongPress(file, index);
        else onToggleSelect(file, index, false);
      }, LONG_PRESS_MS),
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    const start = press.current;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP) {
      cancelPress();
    }
  };

  const className = [
    'media-tile',
    selected ? 'is-selected' : '',
    selecting ? 'is-selecting' : '',
    hasThumb ? '' : 'is-placeholder',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      // The picture's average colour stands in until the thumbnail arrives.
      style={{
        top,
        left,
        width,
        height,
        backgroundColor: hasThumb ? file.color : undefined,
      }}
      data-testid="media-tile"
    >
      <button
        type="button"
        className="media-tile-main"
        tabIndex={tabbable ? 0 : -1}
        data-index={index}
        aria-label={selected ? `${file.name}, selected` : file.name}
        title={file.rel_path}
        onClick={(event) => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          onActivate(file, index, event);
        }}
        onFocus={() => onFocusTile(index)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(event) => {
          if (!onContextMenu) return;
          event.preventDefault();
          if (longPressed.current) return;
          onContextMenu(file, event.clientX, event.clientY);
        }}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(
            'application/cairn-file',
            JSON.stringify({ id: file.id, rel_path: file.rel_path, name: file.name }),
          );
          event.dataTransfer.effectAllowed = 'copyMove';
        }}
      >
        {hasThumb && isVideo ? (
          <VideoThumb libraryId={itemLibraryId} fileId={file.id} className="media-tile-img" />
        ) : hasThumb ? (
          // Not loading="lazy": the grid only mounts tiles near the viewport,
          // and a lazy image could hold a download slot without downloading.
          <img
            ref={attachImage}
            className="media-tile-img"
            src={shownSrc}
            alt=""
            decoding="async"
            draggable={false}
            onLoad={(event) => {
              event.currentTarget.dataset.loaded = 'true';
              settleThumb(true);
            }}
            onError={() => {
              if (!single) {
                // A stored copy that will not decode: fetch it the usual way.
                setBatchBroken(true);
                return;
              }
              settleThumb(false);
              setThumbState({
                ...thumb,
                phase: thumb.retries < THUMB_RETRY_MS.length ? 'waiting' : 'failed',
              });
            }}
          />
        ) : (
          <span className="media-tile-glyph" aria-hidden="true">
            <Icon
              name={failed ? 'image-off' : mediaTypeIcon(file.media_type)}
              size={isVideo ? 28 : 26}
            />
          </span>
        )}
        <span className="media-tile-caption">{file.name}</span>
      </button>

      {isVideo && (
        <span className="media-tile-badge media-tile-video" aria-hidden="true">
          <Icon name="play" size={14} filled />
        </span>
      )}
      {favorite && (
        <span className="media-tile-badge media-tile-favorite" aria-label="Favorite" role="img">
          <Icon name="star" size={14} filled />
        </span>
      )}

      <LibraryTag libraryId={file.library_id} corner />

      {selectable && (
        <button
          type="button"
          className="media-tile-check"
          tabIndex={-1}
          aria-label={selected ? `Deselect ${file.name}` : `Select ${file.name}`}
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect(file, index, event.shiftKey);
          }}
        >
          <Icon name="check" size={14} />
        </button>
      )}
    </div>
  );
}

export const MediaTile = memo(MediaTileImpl);
