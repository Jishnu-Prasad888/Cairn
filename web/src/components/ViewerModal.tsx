/**
 * The media viewer: the photo, full window, on a dark surround.
 *
 * Everything else is secondary and appears only when wanted. The controls fade
 * after a few seconds of stillness and return on any movement or key; the
 * details open in a side panel on request; editing actions live behind "More".
 * The viewer never mutates a file behind the page's back — rename, move, copy,
 * and trash are handed to the page through `onRequestAction`, which owns the
 * dialogs and the reload.
 *
 * Images load progressively: the grid's thumbnail is shown at once, blurred,
 * and the original replaces it when it arrives. Videos stream (the download
 * route supports Range requests), so a large file starts playing at once and
 * is never held in memory.
 *
 * Keyboard: ← → navigate, + − zoom, 0 fit, Space play/pause, F fullscreen,
 * S slideshow, I (or T) details, H hide controls, Esc close.
 */

import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';

import { addFavorite, getFileMetadata, listFavorites, removeFavorite } from '../api/queries';
import type { FileMetadata, FileSummary } from '../api/types';
import { formatDateTime } from '../lib/dates';
import { useFocusTrap } from '../lib/focusTrap';
import { FileNote } from './FileNote';
import { downloadUrl, thumbnailUrl, mediaTypeIcon } from './media';
import { Icon, type IconName } from './ui/Icon';
import { Menu, useMenuButton, withDangerLast } from './ui/Menu';
import { AlbumsPanel } from './viewer/AlbumsPanel';
import { DetailsPanel } from './viewer/DetailsPanel';
import { Filmstrip } from './viewer/Filmstrip';
import { MemoriesPanel, PeoplePanel, SimilarPanel } from './viewer/RelatedPanels';
import { SharePanel } from './viewer/SharePanel';
import { TagsPanel } from './viewer/TagsPanel';
import './ViewerModal.css';

/** File operations the viewer asks the page to perform. */
export type ViewerAction = 'rename' | 'move' | 'copy' | 'trash';

export interface ViewerModalProps {
  libraryId: string;
  file: FileSummary;
  /** The list the viewer pages through with ← and →. */
  siblings: FileSummary[];
  onNavigate: (file: FileSummary) => void;
  /** Something changed on the server; the page should reload its listing. */
  onChanged: () => void;
  /** Ask the page to run a file operation in its own dialog. */
  onRequestAction: (action: ViewerAction, file: FileSummary) => void;
  /** Dismiss the viewer. */
  onClose: () => void;
  /** Called near the end of `siblings`, so the page can fetch the next page. */
  onNearEnd?: (() => void) | undefined;
}

type PanelTab = 'details' | 'tags' | 'albums' | 'people' | 'memories' | 'similar' | 'share';

const PANEL_TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'details', label: 'Details' },
  { id: 'tags', label: 'Tags' },
  { id: 'albums', label: 'Albums' },
  { id: 'people', label: 'People' },
  { id: 'memories', label: 'Memories' },
  { id: 'similar', label: 'Similar' },
  { id: 'share', label: 'Share' },
];

const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];
const SLIDESHOW_MS = 4000;
const CHROME_IDLE_MS = 3500;
const SWIPE_PX = 50;
const NEAR_END = 3;

const PANEL_STORAGE_KEY = 'cairn.viewer.panel';

/** Whether the person last left the details panel open. Closed by default. */
function readPanelPreference(): boolean {
  try {
    return localStorage.getItem(PANEL_STORAGE_KEY) === 'open';
  } catch {
    return false;
  }
}

function writePanelPreference(open: boolean): void {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // The choice just is not remembered.
  }
}

export function ViewerModal({
  libraryId,
  file,
  siblings,
  onNavigate,
  onChanged,
  onRequestAction,
  onClose,
  onNearEnd,
}: ViewerModalProps) {
  const [zoom, setZoom] = useState(1);
  const [slideshowWanted, setSlideshowWanted] = useState(false);
  const [panelOpen, setPanelOpen] = useState(readPanelPreference);
  const [chromeHidden, setChromeHidden] = useState(false);
  const [tab, setTab] = useState<PanelTab>('details');
  // The original image's load state, tagged with the file it describes so
  // navigating never shows the previous photo's state.
  const [original, setOriginal] = useState<{ id: string; state: 'loaded' | 'failed' } | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string> | null>(null);
  const [metadataState, setMetadataState] = useState<{
    fileId: string;
    value: FileMetadata | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const more = useMenuButton();

  const dialogRef = useRef<HTMLDivElement | null>(null);
  // The same element, as state, for mounting the "More" menu inside the dialog.
  const [dialogEl, setDialogEl] = useState<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);

  const index = siblings.findIndex((f) => f.id === file.id);
  const position = index >= 0 ? index + 1 : 0;
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < siblings.length - 1;

  const goPrev = useCallback(() => {
    if (hasPrev) onNavigate(siblings[index - 1]!);
  }, [hasPrev, index, onNavigate, siblings]);

  const goNext = useCallback(() => {
    if (hasNext) onNavigate(siblings[index + 1]!);
  }, [hasNext, index, onNavigate, siblings]);

  // Paging toward the end of what is loaded fetches more, so the viewer can
  // keep going through a library larger than one page.
  useEffect(() => {
    if (onNearEnd && index >= 0 && index >= siblings.length - NEAR_END) onNearEnd();
  }, [index, siblings.length, onNearEnd]);

  const close = useCallback(() => {
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    onClose();
  }, [onClose]);

  // Reset per-file view state when navigating, during render rather than in
  // an effect, so the previous zoom is never drawn for a frame.
  const [prevFileId, setPrevFileId] = useState(file.id);
  if (prevFileId !== file.id) {
    setPrevFileId(file.id);
    setZoom(1);
    setError(null);
  }

  // Focus the dialog on open, keep the page behind from scrolling, and give
  // focus back to the tile that opened it on close.
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      restore?.focus?.();
    };
  }, []);

  useFocusTrap(dialogRef);

  const toggleFullscreen = useCallback(() => {
    const el = dialogEl;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void el.requestFullscreen?.().catch(() => undefined);
    }
  }, [dialogEl]);

  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      writePanelPreference(!open);
      return !open;
    });
  }, []);

  const openPanelAt = useCallback((next: PanelTab) => {
    setTab(next);
    setPanelOpen(true);
    writePanelPreference(true);
  }, []);

  // Idle timer: hide the interface after a few seconds without input.
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armIdle = useCallback(() => {
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(() => setChromeHidden(true), CHROME_IDLE_MS);
  }, []);
  const revealChrome = useCallback(() => {
    setChromeHidden((hidden) => (hidden ? false : hidden));
    armIdle();
  }, [armIdle]);
  useEffect(() => {
    armIdle();
    return () => {
      if (idleRef.current) clearTimeout(idleRef.current);
    };
  }, [armIdle, file.id]);

  const stepZoom = useCallback((direction: 1 | -1) => {
    setZoom((current) => {
      const pos = ZOOM_STEPS.indexOf(current);
      if (pos === -1) return direction === 1 ? ZOOM_STEPS[1]! : ZOOM_STEPS[0]!;
      const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, pos + direction));
      return ZOOM_STEPS[next]!;
    });
  }, []);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play()?.catch(() => undefined);
    else video.pause();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A menu opened from the viewer has already handled its keys.
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // A dialog above the viewer (rename, move) owns the keyboard.
      if (
        target instanceof Element &&
        target !== document.body &&
        !dialogRef.current?.contains(target)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          close();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          goPrev();
          break;
        case 'ArrowRight':
          e.preventDefault();
          goNext();
          break;
        case '+':
        case '=':
          e.preventDefault();
          stepZoom(1);
          break;
        case '-':
          e.preventDefault();
          stepZoom(-1);
          break;
        case '0':
          e.preventDefault();
          setZoom(1);
          break;
        case ' ':
          // Space on a focused button presses it; elsewhere it plays a video.
          if (videoRef.current && !(target instanceof HTMLButtonElement)) {
            e.preventDefault();
            togglePlayback();
          }
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 's':
        case 'S':
          e.preventDefault();
          setSlideshowWanted((v) => !v);
          break;
        case 'i':
        case 'I':
        case 't':
        case 'T':
          e.preventDefault();
          togglePanel();
          break;
        case 'h':
        case 'H':
          e.preventDefault();
          setChromeHidden((v) => !v);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, goNext, goPrev, stepZoom, toggleFullscreen, togglePanel, togglePlayback]);

  // Slideshow: advance through the siblings and stop at the end rather than
  // looping behind the user's back. Whether it is running is derived, so
  // reaching the last file ends it without an effect switching it off.
  const slideshow = slideshowWanted && hasNext;

  useEffect(() => {
    if (!slideshow) return;
    const timer = setTimeout(goNext, SLIDESHOW_MS);
    return () => clearTimeout(timer);
  }, [slideshow, goNext]);

  // Ctrl/Cmd + wheel zooms, matching the browser's own page-zoom gesture.
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  };

  // On touch screens a horizontal swipe pages and a downward pull closes,
  // as long as the photo is not zoomed in.
  const onTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    swipeRef.current =
      touch && e.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    const touch = e.changedTouches[0];
    if (!start || !touch || zoom > 1) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) goNext();
      else goPrev();
    } else if (dy > SWIPE_PX * 2 && Math.abs(dy) > Math.abs(dx) * 1.5) {
      close();
    }
  };

  // Favorites are read once per viewer rather than once per photo; metadata
  // per photo. Both are best-effort: a failure hides the star or the extra
  // details rather than blocking the viewer.
  useEffect(() => {
    let cancelled = false;
    listFavorites(libraryId)
      .then((resp) => {
        if (!cancelled) setFavoriteIds(new Set((resp.files ?? []).map((f) => f.id)));
      })
      .catch(() => {
        if (!cancelled) setFavoriteIds(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId]);

  useEffect(() => {
    let cancelled = false;
    const fileId = file.id;
    getFileMetadata(libraryId, fileId)
      .then((resp) => {
        if (!cancelled) setMetadataState({ fileId, value: resp.metadata ?? null });
      })
      .catch(() => {
        if (!cancelled) setMetadataState({ fileId, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, file.id]);

  const favorite = favoriteIds === null ? null : favoriteIds.has(file.id);
  const metadata = metadataState?.fileId === file.id ? metadataState.value : null;

  const setFavoriteLocally = (id: string, value: boolean) =>
    setFavoriteIds((ids) => {
      const updated = new Set(ids);
      if (value) updated.add(id);
      else updated.delete(id);
      return updated;
    });

  const toggleFavorite = async () => {
    if (favorite === null) return;
    const id = file.id;
    const next = !favorite;
    setBusy(true);
    setError(null);
    // Optimistic: the star fills now and is put back if the request fails.
    setFavoriteLocally(id, next);
    try {
      if (next) await addFavorite(libraryId, id);
      else await removeFavorite(libraryId, id);
      onChanged();
    } catch (e: unknown) {
      setFavoriteLocally(id, !next);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isPhoto = file.media_type === 'photo';
  const isVideo = file.media_type === 'video';
  const originalState = original?.id === file.id ? original.state : null;
  const originalShown = originalState === 'loaded' || originalState === 'failed';

  // A CSS transform does not grow the layout box, so the edges of a scaled
  // photo could never be scrolled to. Size the element itself once zoomed,
  // and let the stage do the scrolling.
  const mediaStyle: CSSProperties =
    zoom > 1
      ? { width: `${zoom * 100}%`, maxWidth: 'none', height: 'auto', maxHeight: 'none' }
      : {};

  const when = formatDateTime(metadata?.taken_at ?? file.mod_time);

  const moreItems = withDangerLast([
    {
      id: 'rename',
      label: 'Rename',
      icon: 'edit',
      onSelect: () => onRequestAction('rename', file),
    },
    {
      id: 'move',
      label: 'Move',
      icon: 'folder-move',
      onSelect: () => onRequestAction('move', file),
    },
    { id: 'copy', label: 'Copy', icon: 'copy', onSelect: () => onRequestAction('copy', file) },
    { id: 'albums', label: 'Add to album', icon: 'album', onSelect: () => openPanelAt('albums') },
    { id: 'share', label: 'Share', icon: 'share', onSelect: () => openPanelAt('share') },
    {
      id: 'download',
      label: 'Download',
      icon: 'download',
      href: downloadUrl(libraryId, file),
    },
    { id: 'tags', label: 'Tags', icon: 'tag', onSelect: () => openPanelAt('tags') },
    {
      id: 'slideshow',
      label: slideshow ? 'Stop slideshow' : 'Slideshow',
      icon: 'slideshow',
      disabled: siblings.length < 2,
      onSelect: () => setSlideshowWanted((v) => !v),
      testId: 'slideshow-toggle',
    },
    {
      id: 'fullscreen',
      label: 'Fullscreen',
      icon: 'fullscreen',
      onSelect: toggleFullscreen,
    },
    {
      id: 'hide',
      label: 'Hide controls',
      icon: 'eye-off',
      onSelect: () => setChromeHidden(true),
      testId: 'hide-controls',
    },
  ]);

  const tool = (
    name: IconName,
    label: string,
    onClick: () => void,
    extra: { pressed?: boolean; disabled?: boolean; title?: string; testId?: string } = {},
  ) => (
    <button
      type="button"
      className={extra.pressed ? 'viewer-tool active' : 'viewer-tool'}
      onClick={onClick}
      disabled={extra.disabled}
      aria-label={label}
      aria-pressed={extra.pressed}
      title={extra.title ?? label}
      data-testid={extra.testId}
    >
      <Icon name={name} filled={name === 'star' && extra.pressed === true} />
    </button>
  );

  return (
    <div
      className="viewer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      data-testid="viewer"
    >
      <div
        className={[
          'viewer-modal',
          panelOpen ? 'panel-open' : '',
          chromeHidden ? 'chrome-hidden' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={file.name}
        tabIndex={-1}
        ref={(el) => {
          dialogRef.current = el;
          setDialogEl(el);
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseMove={revealChrome}
        onTouchStart={revealChrome}
        onKeyDown={revealChrome}
      >
        <header className="viewer-toolbar viewer-chrome">
          <button
            type="button"
            className="viewer-tool"
            onClick={close}
            aria-label="Close viewer"
            title="Close (Esc)"
          >
            <Icon name="arrow-left" />
          </button>
          <div className="viewer-title">
            <span className="viewer-title-name" title={file.rel_path}>
              {file.name}
            </span>
            <span className="viewer-title-sub" aria-live="polite">
              {siblings.length > 1 ? `${position} of ${siblings.length}` : when}
            </span>
          </div>

          <div className="viewer-toolbar-actions">
            {isPhoto && (
              <div className="viewer-tool-group viewer-zoom" role="group" aria-label="Zoom">
                {tool('minus', 'Zoom out', () => stepZoom(-1), { disabled: zoom === 1 })}
                <button
                  type="button"
                  className="viewer-tool viewer-tool-wide"
                  onClick={() => setZoom(1)}
                  aria-label="Reset zoom"
                  title="Fit to window (0)"
                >
                  {Math.round(zoom * 100)}%
                </button>
                {tool('plus', 'Zoom in', () => stepZoom(1), {
                  disabled: zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1],
                })}
              </div>
            )}
            {tool(
              'star',
              favorite ? 'Remove from favorites' : 'Add to favorites',
              () => void toggleFavorite(),
              {
                pressed: favorite === true,
                disabled: favorite === null || busy,
                testId: 'viewer-favorite',
              },
            )}
            {tool('share', 'Share', () => openPanelAt('share'))}
            <a
              className="viewer-tool"
              href={downloadUrl(libraryId, file)}
              download={file.name}
              aria-label="Download"
              title="Download"
            >
              <Icon name="download" />
            </a>
            <button
              type="button"
              className={panelOpen ? 'viewer-tool active' : 'viewer-tool'}
              onClick={togglePanel}
              aria-expanded={panelOpen}
              aria-controls="viewer-panel"
              aria-label="Details"
              title="Details (I)"
              data-testid="toggle-panel"
            >
              <Icon name="info" />
            </button>
            {tool('trash', 'Move to trash', () => onRequestAction('trash', file), {
              disabled: busy,
              testId: 'viewer-trash',
            })}
            <button
              type="button"
              className="viewer-tool"
              aria-label="More options"
              aria-haspopup="menu"
              aria-expanded={more.open}
              onClick={more.toggle}
              title="More options"
              data-testid="viewer-more"
            >
              <Icon name="more" />
            </button>
          </div>
        </header>

        <div className="viewer-stage-wrap">
          <div
            className="viewer-stage"
            onWheel={onWheel}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            onDoubleClick={() => {
              if (isPhoto) setZoom((z) => (z === 1 ? 2 : 1));
            }}
            data-testid="viewer-stage"
            data-zoomed={zoom > 1}
          >
            {isPhoto ? (
              <>
                {/* The grid's thumbnail, shown at once while the original loads. */}
                {!originalShown && (
                  <img
                    key={`preview-${file.id}`}
                    className="viewer-media viewer-preview"
                    src={thumbnailUrl(libraryId, file)}
                    alt=""
                    aria-hidden="true"
                  />
                )}
                <img
                  key={file.id}
                  className={originalShown ? 'viewer-media' : 'viewer-media is-loading'}
                  // The thumbnail is far too small to fill a window; show the
                  // original, falling back to the preview for a format the
                  // browser cannot decode (HEIC, RAW).
                  src={
                    originalState === 'failed'
                      ? thumbnailUrl(libraryId, file)
                      : downloadUrl(libraryId, file)
                  }
                  onLoad={() =>
                    setOriginal((o) =>
                      o?.id === file.id && o.state === 'failed'
                        ? o
                        : { id: file.id, state: 'loaded' },
                    )
                  }
                  onError={() => setOriginal({ id: file.id, state: 'failed' })}
                  alt={file.name}
                  style={mediaStyle}
                  draggable={false}
                />
              </>
            ) : isVideo ? (
              <video
                key={file.id}
                ref={videoRef}
                className="viewer-media"
                src={downloadUrl(libraryId, file)}
                controls
                autoPlay
                playsInline
                preload="metadata"
                style={mediaStyle}
              />
            ) : (
              <div className="viewer-generic">
                <span className="viewer-generic-icon" aria-hidden="true">
                  <Icon name={mediaTypeIcon(file.media_type)} size={40} />
                </span>
                <p className="viewer-generic-name">{file.name}</p>
                <p className="viewer-generic-note">There's no preview for this kind of file.</p>
                <a
                  className="button primary-button"
                  href={downloadUrl(libraryId, file)}
                  download={file.name}
                >
                  <Icon name="download" />
                  Download to open
                </a>
              </div>
            )}
          </div>
        </div>

        {slideshow && (
          <p className="viewer-slideshow-note viewer-chrome" role="status">
            Slideshow · press S to stop
          </p>
        )}

        {hasPrev && (
          <button
            type="button"
            className="viewer-nav viewer-nav-prev viewer-chrome"
            onClick={goPrev}
            aria-label="Previous item"
          >
            <Icon name="chevron-left" size={28} />
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            className="viewer-nav viewer-nav-next viewer-chrome"
            onClick={goNext}
            aria-label="Next item"
          >
            <Icon name="chevron-right" size={28} />
          </button>
        )}

        <div className="viewer-bottom viewer-chrome">
          {/* Keyed by file so navigating remounts it with a clean note. */}
          <FileNote key={file.id} libraryId={libraryId} fileId={file.id} />
          {siblings.length > 1 && (
            <Filmstrip
              libraryId={libraryId}
              siblings={siblings}
              index={index}
              onNavigate={onNavigate}
            />
          )}
        </div>

        {panelOpen && (
          <aside className="viewer-panel" id="viewer-panel" aria-label="File details and actions">
            <header className="viewer-panel-head">
              <h2>Info</h2>
              <button
                type="button"
                className="viewer-tool"
                onClick={togglePanel}
                aria-label="Close details"
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="viewer-tabs" role="tablist" aria-label="File information">
              {PANEL_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`viewer-tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls="viewer-tabpanel"
                  tabIndex={tab === t.id ? 0 : -1}
                  className={tab === t.id ? 'viewer-tab active' : 'viewer-tab'}
                  onClick={() => setTab(t.id)}
                  onKeyDown={(event) => {
                    // Arrow keys move between tabs (the tablist pattern), not
                    // between photos.
                    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                    event.preventDefault();
                    const i = PANEL_TABS.findIndex((x) => x.id === tab);
                    const step = event.key === 'ArrowRight' ? 1 : -1;
                    const next = PANEL_TABS[(i + step + PANEL_TABS.length) % PANEL_TABS.length]!;
                    setTab(next.id);
                    document.getElementById(`viewer-tab-${next.id}`)?.focus();
                  }}
                  data-testid={`viewer-tab-${t.id}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div
              className="viewer-tabpanel"
              role="tabpanel"
              id="viewer-tabpanel"
              aria-labelledby={`viewer-tab-${tab}`}
              tabIndex={0}
            >
              {tab === 'details' && <DetailsPanel key={file.id} file={file} metadata={metadata} />}
              {tab === 'tags' && (
                <TagsPanel key={file.id} libraryId={libraryId} file={file} onChanged={onChanged} />
              )}
              {tab === 'albums' && (
                <AlbumsPanel
                  key={file.id}
                  libraryId={libraryId}
                  file={file}
                  onChanged={onChanged}
                />
              )}
              {tab === 'people' && <PeoplePanel key={file.id} libraryId={libraryId} file={file} />}
              {tab === 'memories' && (
                <MemoriesPanel key={file.id} libraryId={libraryId} file={file} />
              )}
              {tab === 'similar' && (
                <SimilarPanel key={file.id} libraryId={libraryId} file={file} onOpen={onNavigate} />
              )}
              {tab === 'share' && <SharePanel key={file.id} libraryId={libraryId} file={file} />}
            </div>
          </aside>
        )}

        {error && (
          <p className="viewer-error" role="alert">
            {error}
          </p>
        )}

        {more.anchor && (
          <Menu
            anchor={more.anchor}
            align="end"
            items={moreItems}
            onClose={more.close}
            label="More options"
            tone="dark"
            container={dialogEl}
          />
        )}
      </div>
    </div>
  );
}
