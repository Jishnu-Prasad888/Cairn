/**
 * The media viewer.
 *
 * This is the app's most-used surface, so it carries everything the brief
 * promises for §15: fullscreen, zoom, previous/next, a slideshow, and the
 * people / memory / similar-file associations. It also stops owning anything
 * the *page* should own: it never calls `window.prompt` or `window.confirm`,
 * and it never mutates a file behind the caller's back. Rename, move, copy, and
 * trash are requested via {@link ViewerModalProps.onRequestAction} so the page
 * that rendered the viewer can put its own accessible dialog in charge of the
 * confirmation and the error handling.
 *
 * Keyboard (as documented in the footer): ← → navigate, + − zoom, 0 reset,
 * F fullscreen, S slideshow, T details, Esc close.
 */

import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  addFavorite,
  addFileTag,
  createShare,
  createTag,
  getFileMetadata,
  getSimilarFiles,
  listAlbumFiles,
  listAlbums,
  listFavorites,
  listFileTags,
  listMemoryRefs,
  listMemories,
  listPeople,
  listTags,
  removeFavorite,
  removeFileTag,
  addAlbumFile,
  removeAlbumFile,
  searchFiles,
} from '../api/queries';
import type {
  Album,
  FileMetadata,
  FileSummary,
  Memory,
  Person,
  SimilarFile,
  Tag,
} from '../api/types';
import { formatBytes } from '../api/types';
import { useFocusTrap } from '../lib/focusTrap';
import { FileNote } from './FileNote';
import { downloadUrl, mediaGlyph, thumbnailUrl } from './media';
import './views.css';
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
}

type PanelTab = 'details' | 'tags' | 'people' | 'memories' | 'similar' | 'share' | 'albums';

const PANEL_TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'details', label: 'Details' },
  { id: 'tags', label: 'Tags' },
  { id: 'people', label: 'People' },
  { id: 'memories', label: 'Memories' },
  { id: 'similar', label: 'Similar' },
  { id: 'share', label: 'Share' },
  { id: 'albums', label: 'Albums' },
];

const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];
const SLIDESHOW_MS = 4000;

export function ViewerModal({
  libraryId,
  file,
  siblings,
  onNavigate,
  onChanged,
  onRequestAction,
  onClose,
}: ViewerModalProps) {
  const [zoom, setZoom] = useState(1);
  const [slideshowWanted, setSlideshowWanted] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [tab, setTab] = useState<PanelTab>('details');
  // Both are tagged with the file they describe, so navigating never shows the
  // previous file's favourite or metadata while the new request is in flight.
  const [favoriteState, setFavoriteState] = useState<{ fileId: string; value: boolean } | null>(
    null,
  );
  const [metadataState, setMetadataState] = useState<{
    fileId: string;
    value: FileMetadata | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

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

  const close = useCallback(() => {
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    onClose();
  }, [onClose]);
  // Reset per-file state when navigating within the same viewer. Adjusted
  // during render (the React-recommended way to reset state on a prop change)
  // rather than in an effect, which would show the stale zoom for a frame.
  const [prevFileId, setPrevFileId] = useState(file.id);
  if (prevFileId !== file.id) {
    setPrevFileId(file.id);
    setZoom(1);
    setError(null);
  }

  // Focus the dialog on open and give focus back to the tile on unmount. The
  // dialog is `aria-modal`, so Tab has to stay inside it — this one listens on
  // `window` because its arrow keys and Escape are global.
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      restoreRef.current?.focus?.();
    };
  }, []);

  useFocusTrap(dialogRef);

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void el.requestFullscreen?.().catch(() => undefined);
    }
  }, []);

  const stepZoom = useCallback((direction: 1 | -1) => {
    setZoom((current) => {
      const pos = ZOOM_STEPS.indexOf(current);
      if (pos === -1) return direction === 1 ? ZOOM_STEPS[1]! : ZOOM_STEPS[0]!;
      const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, pos + direction));
      return ZOOM_STEPS[next]!;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never steal keys from a field the user is typing in.
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
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
        case 't':
        case 'T':
          e.preventDefault();
          setPanelOpen((v) => !v);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, goNext, goPrev, stepZoom, toggleFullscreen]);

  // Slideshow: advance through the siblings, and stop at the end rather than
  // looping forever behind the user's back. Whether it is *running* is derived
  // so reaching the last file ends the show without an effect having to switch
  // it off (and leave the toolbar showing "stopped" a render later).
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

  // Favorite state and extracted metadata are best-effort; a failure hides the
  // control or the details rather than blocking the viewer. Both results are
  // tagged with the file they belong to, so navigating invalidates them without
  // an explicit reset.
  useEffect(() => {
    let cancelled = false;
    const fileId = file.id;

    void listFavorites(libraryId)
      .then((resp) => {
        if (!cancelled) {
          setFavoriteState({ fileId, value: resp.files?.some((f) => f.id === fileId) ?? false });
        }
      })
      .catch(() => {
        if (!cancelled) setFavoriteState({ fileId, value: false });
      });

    void getFileMetadata(libraryId, fileId)
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

  const favorite = favoriteState?.fileId === file.id ? favoriteState.value : null;
  const metadata = metadataState?.fileId === file.id ? metadataState.value : null;

  const toggleFavorite = async () => {
    if (favorite === null) return;
    setBusy(true);
    setError(null);
    try {
      if (favorite) {
        await removeFavorite(libraryId, file.id);
        setFavoriteState({ fileId: file.id, value: false });
      } else {
        await addFavorite(libraryId, file.id);
        setFavoriteState({ fileId: file.id, value: true });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const previewable = file.media_type === 'photo' || file.media_type === 'video';

  // A CSS `transform` does not change the layout box: a scaled image overflows
  // a scroll container that does not know it has got bigger, so the edges of a
  // zoomed photo are drawn but can never be scrolled to. Size the element
  // itself once zoomed, and let the stage do the scrolling.
  const mediaStyle: CSSProperties =
    zoom > 1
      ? { width: `${zoom * 100}%`, maxWidth: 'none', height: 'auto', objectFit: 'contain' }
      : {};

  const stage = (
    <div
      className="viewer-stage"
      ref={stageRef}
      onWheel={onWheel}
      data-testid="viewer-stage"
      data-zoomed={zoom > 1}
    >
      {file.media_type === 'photo' ? (
        <img
          className="viewer-media"
          src={thumbnailUrl(libraryId, file)}
          alt={file.name}
          style={mediaStyle}
        />
      ) : file.media_type === 'video' ? (
        <video
          className="viewer-media"
          src={downloadUrl(libraryId, file)}
          controls
          style={mediaStyle}
        />
      ) : (
        <div className="viewer-generic">
          <span className="viewer-glyph" aria-hidden="true">
            {mediaGlyph(file)}
          </span>
          <p>{file.name}</p>
          <p className="muted">No preview for this file type. Download it to open it.</p>
        </div>
      )}
    </div>
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
        className="viewer-modal"
        role="dialog"
        aria-modal="true"
        aria-label={file.name}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="viewer-toolbar">
          <button type="button" className="viewer-tool" onClick={close} aria-label="Close viewer">
            ✕
          </button>
          <span className="viewer-position" aria-live="polite">
            {siblings.length > 1 ? `${position} of ${siblings.length}` : file.name}
          </span>
          <div className="viewer-toolbar-actions">
            {hasPrev && (
              <button
                type="button"
                className="viewer-tool"
                onClick={goPrev}
                aria-label="Previous item"
              >
                ‹
              </button>
            )}
            {hasNext && (
              <button type="button" className="viewer-tool" onClick={goNext} aria-label="Next item">
                ›
              </button>
            )}
            {previewable && (
              <>
                <button
                  type="button"
                  className="viewer-tool"
                  onClick={() => stepZoom(-1)}
                  disabled={zoom === 1}
                  aria-label="Zoom out"
                >
                  −
                </button>
                <button
                  type="button"
                  className="viewer-tool viewer-tool-wide"
                  onClick={() => setZoom(1)}
                  aria-label="Reset zoom"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  className="viewer-tool"
                  onClick={() => stepZoom(1)}
                  disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                  aria-label="Zoom in"
                >
                  +
                </button>
                <button
                  type="button"
                  className="viewer-tool"
                  onClick={toggleFullscreen}
                  aria-label="Toggle fullscreen"
                  aria-pressed={false}
                >
                  ⛶
                </button>
                <button
                  type="button"
                  className={slideshow ? 'viewer-tool active' : 'viewer-tool'}
                  onClick={() => setSlideshowWanted((v) => !v)}
                  disabled={siblings.length < 2}
                  aria-pressed={slideshow}
                  data-testid="slideshow-toggle"
                >
                  ▶
                </button>
              </>
            )}
            <button
              type="button"
              className="viewer-tool"
              onClick={() => setPanelOpen((v) => !v)}
              aria-expanded={panelOpen}
              aria-controls="viewer-panel"
              data-testid="toggle-panel"
            >
              ⓘ
            </button>
          </div>
        </div>

        {slideshow && (
          <p className="viewer-slideshow-note" role="status">
            Slideshow is playing — press S to stop.
          </p>
        )}

        <div className="viewer-body">
          {stage}

          {/* Scrollable area below the image: note (caption) then detail panel */}
          <div className="viewer-scroll-area">
            {/* Keyed by file so navigating remounts it with a clean note. */}
            <FileNote key={file.id} libraryId={libraryId} fileId={file.id} />

            {panelOpen && (
              <aside
                className="viewer-panel"
                id="viewer-panel"
                aria-label="File details and actions"
              >
                <div className="viewer-meta">
                  <h2 title={file.rel_path}>{file.name}</h2>
                  <p className="muted">
                    {file.folder_path || 'Library root'} · {formatBytes(file.size_bytes)}
                  </p>
                </div>

                <div className="viewer-actions">
                  <a
                    className="button"
                    href={downloadUrl(libraryId, file)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Download
                  </a>
                  <button
                    type="button"
                    className={
                      favorite ? 'button favorite-button active' : 'button favorite-button'
                    }
                    onClick={() => void toggleFavorite()}
                    disabled={favorite === null || busy}
                    aria-pressed={favorite === true}
                  >
                    {favorite ? '★ Favorite' : '☆ Favorite'}
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => onRequestAction('rename', file)}
                    disabled={busy}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => onRequestAction('move', file)}
                    disabled={busy}
                  >
                    Move
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => onRequestAction('copy', file)}
                    disabled={busy}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="button danger-button"
                    onClick={() => onRequestAction('trash', file)}
                    disabled={busy}
                    data-testid="viewer-trash"
                  >
                    Move to trash
                  </button>
                </div>

                <div className="viewer-tabs" role="tablist" aria-label="File information">
                  {PANEL_TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      id={`viewer-tab-${t.id}`}
                      aria-selected={tab === t.id}
                      aria-controls="viewer-tabpanel"
                      className={tab === t.id ? 'viewer-tab active' : 'viewer-tab'}
                      onClick={() => setTab(t.id)}
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
                  {tab === 'details' && (
                    <DetailsPanel key={file.id} file={file} metadata={metadata} />
                  )}
                  {tab === 'tags' && (
                    <TagsPanel
                      key={file.id}
                      libraryId={libraryId}
                      file={file}
                      onChanged={onChanged}
                    />
                  )}
                  {tab === 'people' && (
                    <PeoplePanel key={file.id} libraryId={libraryId} file={file} />
                  )}
                  {tab === 'memories' && (
                    <MemoriesPanel key={file.id} libraryId={libraryId} file={file} />
                  )}
                  {tab === 'similar' && (
                    <SimilarPanel
                      key={file.id}
                      libraryId={libraryId}
                      file={file}
                      onOpen={onNavigate}
                    />
                  )}
                  {tab === 'share' && (
                    <SharePanel key={file.id} libraryId={libraryId} file={file} />
                  )}
                  {tab === 'albums' && (
                    <AlbumsPanel
                      key={file.id}
                      libraryId={libraryId}
                      file={file}
                      onChanged={onChanged}
                    />
                  )}
                </div>

                {error && (
                  <p className="error-text" role="alert">
                    {error}
                  </p>
                )}
              </aside>
            )}
          </div>
        </div>

        <p className="viewer-hint muted">
          ← → move · + − zoom · 0 reset · F fullscreen · S slideshow · T details · Esc close
        </p>
      </div>
    </div>
  );
}

/* ------------------------------ panels ------------------------------- */

function DetailsPanel({ file, metadata }: { file: FileSummary; metadata: FileMetadata | null }) {
  return (
    <div data-testid="viewer-details-panel">
      <dl className="viewer-facts">
        <div className="viewer-detail-row">
          <dt>Path</dt>
          <dd>
            <code>{file.rel_path}</code>
          </dd>
        </div>
        <div className="viewer-detail-row">
          <dt>Size</dt>
          <dd>{formatBytes(file.size_bytes)}</dd>
        </div>
        <div className="viewer-detail-row">
          <dt>Type</dt>
          <dd>{file.mime_type || file.media_type}</dd>
        </div>
        <div className="viewer-detail-row">
          <dt>Modified</dt>
          <dd>
            <time dateTime={file.mod_time}>
              {Number.isNaN(Date.parse(file.mod_time))
                ? file.mod_time
                : new Date(file.mod_time).toLocaleString()}
            </time>
          </dd>
        </div>
        {file.status !== 'present' && (
          <div className="viewer-detail-row">
            <dt>Status</dt>
            <dd>{file.status}</dd>
          </div>
        )}
      </dl>

      {!metadata && <p className="muted">No extra details were extracted for this file.</p>}
      {metadata && <FileFacts metadata={metadata} />}
    </div>
  );
}

function FileFacts({ metadata }: { metadata: FileMetadata }) {
  const rows: Array<[string, ReactNode]> = [];

  if (metadata.width && metadata.height) {
    rows.push(['Dimensions', `${metadata.width} × ${metadata.height}px`]);
  }
  if (metadata.duration_secs != null && metadata.duration_secs > 0) {
    const total = Math.round(metadata.duration_secs);
    rows.push(['Duration', `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`]);
  }
  const camera = [metadata.camera_make, metadata.camera_model].filter(Boolean).join(' ');
  if (camera) rows.push(['Camera', camera]);
  if (metadata.taken_at) {
    const taken = new Date(metadata.taken_at);
    rows.push([
      'Taken',
      Number.isNaN(taken.getTime()) ? metadata.taken_at : taken.toLocaleString(),
    ]);
  }
  if (metadata.latitude != null && metadata.longitude != null) {
    const lat = metadata.latitude.toFixed(5);
    const lon = metadata.longitude.toFixed(5);
    rows.push([
      'Location',
      <a
        key="location"
        href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`}
        target="_blank"
        rel="noreferrer"
      >
        {lat}, {lon}
      </a>,
    ]);
  }

  if (rows.length === 0) return null;

  return (
    <div className="viewer-details" data-testid="viewer-details">
      <h3>Extracted details</h3>
      <dl>
        {rows.map(([term, desc]) => (
          <div key={term} className="viewer-detail-row">
            <dt>{term}</dt>
            <dd>{desc}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TagsPanel({
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

  const attachTag = async (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      // Typing a new name creates the tag; an existing one is reused. Cairn has
      // no "find-or-create" endpoint, so the lookup is client-side.
      const existing = libraryTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      let tagId = existing?.id;
      if (!tagId) {
        const created = await createTag(libraryId, name);
        tagId = created.tag.id;
      }
      await addFileTag(libraryId, file.id, tagId);
      setReloadKey((k) => k + 1);
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
                ×
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
          {libraryTags.map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
        <button type="submit" className="button" disabled={busy || tagInput.trim() === ''}>
          Add
        </button>
      </form>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * "Who is in this photo?"
 *
 * The API has no per-file faces endpoint — a person is a cluster of faces
 * across the library, and the only way to ask whether a given person appears
 * in a given file is to search that person's files and look for this one. That
 * is one request per person, so it is only done when the panel is opened, and
 * the count is bounded by a single page of results per person.
 */
function PeoplePanel({ libraryId, file }: { libraryId: string; file: FileSummary }) {
  const [result, setResult] = useState<{ people: Person[]; matches: Set<string> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await listPeople(libraryId);
        const all = resp.people ?? [];
        const results = await Promise.all(
          all.map((person) =>
            searchFiles(libraryId, { person: person.id, limit: 200 })
              .then((listing) => (listing.files ?? []).some((f) => f.id === file.id))
              .catch(() => false),
          ),
        );
        if (cancelled) return;
        setResult({
          people: all,
          matches: new Set(all.filter((_, i) => results[i]).map((p) => p.id)),
        });
        setError(null);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryId, file.id]);

  const people = result?.people ?? null;
  const matches = result?.matches ?? new Set<string>();
  const busy = result === null && error === null;

  if (error) {
    return (
      <p className="error-text" role="alert">
        {error}
      </p>
    );
  }
  if (busy && people === null) {
    return (
      <p className="muted" role="status">
        Looking for familiar faces…
      </p>
    );
  }
  if (!people || people.length === 0) {
    return <p className="muted">No people have been identified in this library yet.</p>;
  }

  const found = people.filter((p) => matches.has(p.id));

  return (
    <div data-testid="viewer-people">
      {found.length === 0 ? (
        <p className="muted">No identified people appear in this file.</p>
      ) : (
        <ul className="viewer-person-list">
          {found.map((person) => (
            <li key={person.id} className="viewer-person">
              {person.cover_file_id && (
                <img
                  className="viewer-person-avatar"
                  src={`/api/v1/libraries/${libraryId}/files/${person.cover_file_id}/thumbnail`}
                  alt=""
                />
              )}
              <a href={`/people?person=${person.id}`}>{person.name}</a>
              <span className="muted">
                {person.face_count} {person.face_count === 1 ? 'face' : 'faces'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted viewer-panel-footnote">
        Based on the people Cairn has named in this library. Run a face pass and clustering on the
        ML page to improve it.
      </p>
    </div>
  );
}

/**
 * Memories that mention this file.
 *
 * A memory references a file with `[[media:<file-id>]]` written in its
 * Markdown body, and the only server-side way to find those is to read each
 * memory's refs. The panel pages the memory list (bounded) and keeps the ones
 * that point here.
 */
function MemoriesPanel({ libraryId, file }: { libraryId: string; file: FileSummary }) {
  const [linked, setLinked] = useState<Memory[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await listMemories(libraryId, { limit: 50 });
        const all = resp.memories ?? [];
        const checks = await Promise.all(
          all.map((m) =>
            listMemoryRefs(libraryId, m.id)
              .then((r) => (r.refs ?? []).some((ref) => ref.type === 'media' && ref.id === file.id))
              .catch(() => false),
          ),
        );
        if (cancelled) return;
        setLinked(all.filter((_, i) => checks[i]));
        setError(null);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryId, file.id]);

  const busy = linked === null && error === null;

  if (error) {
    return (
      <p className="error-text" role="alert">
        {error}
      </p>
    );
  }
  if (busy) {
    return (
      <p className="muted" role="status">
        Checking memories…
      </p>
    );
  }
  if (!linked || linked.length === 0) {
    return (
      <p className="muted">
        No memory mentions this file yet. Add <code>[[media:{file.id}]]</code> to a memory to link
        it.
      </p>
    );
  }

  return (
    <ul className="viewer-memory-list" data-testid="viewer-memories">
      {linked.map((m) => (
        <li key={m.id}>
          <a href={`/memories?q=${encodeURIComponent(m.title)}`}>{m.title}</a>
          {m.memory_date && <span className="muted"> · {m.memory_date}</span>}
        </li>
      ))}
    </ul>
  );
}

function SimilarPanel({
  libraryId,
  file,
  onOpen,
}: {
  libraryId: string;
  file: FileSummary;
  onOpen: (file: FileSummary) => void;
}) {
  const [similar, setSimilar] = useState<SimilarFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSimilarFiles(libraryId, file.id)
      .then((resp) => {
        if (cancelled) return;
        setSimilar(resp.similar ?? []);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // ML being disabled is the common case and is not a failure to report
        // as a broken page — say so plainly instead.
        setError(e instanceof Error ? e.message : String(e));
        setSimilar([]);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, file.id]);

  if (similar === null && error === null) {
    return (
      <p className="muted" role="status">
        Looking for similar files…
      </p>
    );
  }
  if (error) {
    return (
      <p className="muted" data-testid="viewer-similar-unavailable">
        Similarity search needs the optional local ML component, which is not available on this
        server.
      </p>
    );
  }
  if (!similar || similar.length === 0) {
    return <p className="muted">No visually similar files were found.</p>;
  }

  return (
    <ul className="viewer-similar-list" data-testid="viewer-similar">
      {similar.map((s) => {
        const target = s.file ?? null;
        return (
          <li key={s.file_id} className="viewer-similar-item">
            {target ? (
              <>
                <button
                  type="button"
                  className="viewer-similar-thumb"
                  onClick={() => onOpen(target)}
                  aria-label={`Open ${target.name}`}
                >
                  <img src={thumbnailUrl(libraryId, target)} alt="" loading="lazy" />
                </button>
                <span className="viewer-similar-name">{target.name}</span>
              </>
            ) : (
              <span className="viewer-similar-name" title={s.file_path}>
                {s.file_path}
              </span>
            )}
            <span className="muted">{Math.round(s.similarity * 100)}%</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Albums panel: shows which albums already contain this file, and lets the
 * user add it to any other album in the library.
 */
function AlbumsPanel({
  libraryId,
  file,
  onChanged,
}: {
  libraryId: string;
  file: FileSummary;
  onChanged: () => void;
}) {
  const [allAlbums, setAllAlbums] = useState<Album[] | null>(null);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await listAlbums(libraryId);
        const albums = resp.albums ?? [];
        // Check which albums contain this file.
        const checks = await Promise.all(
          albums.map((a) =>
            listAlbumFiles(libraryId, a.id)
              .then((r) => (r.files ?? []).some((f) => f.id === file.id))
              .catch(() => false),
          ),
        );
        if (cancelled) return;
        setAllAlbums(albums);
        setMemberIds(new Set(albums.filter((_, i) => checks[i]).map((a) => a.id)));
        setError(null);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryId, file.id, reloadKey]);

  const toggle = async (album: Album) => {
    setBusy(true);
    setError(null);
    try {
      if (memberIds.has(album.id)) {
        await removeAlbumFile(libraryId, album.id, file.id);
      } else {
        await addAlbumFile(libraryId, album.id, file.id);
      }
      setReloadKey((k) => k + 1);
      onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (allAlbums === null && error === null) {
    return (
      <p className="muted" role="status">
        Loading albums…
      </p>
    );
  }

  if (error) {
    return (
      <p className="error-text" role="alert">
        {error}
      </p>
    );
  }

  if (!allAlbums || allAlbums.length === 0) {
    return (
      <p className="muted">No albums yet. Create one from the Albums page to group your files.</p>
    );
  }

  return (
    <div data-testid="viewer-albums">
      <ul className="viewer-album-list">
        {allAlbums.map((album) => {
          const inAlbum = memberIds.has(album.id);
          return (
            <li key={album.id} className="viewer-album-row">
              <span className="viewer-album-name">{album.name}</span>
              <button
                type="button"
                className={inAlbum ? 'button viewer-album-btn active' : 'button viewer-album-btn'}
                disabled={busy}
                onClick={() => void toggle(album)}
                aria-pressed={inAlbum}
              >
                {inAlbum ? '✓ In album' : '+ Add'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Sharing. Shares are created at a resource key, and a file's key is
 * `file:<library>/<rel-path>`, so a share here exposes exactly this file.
 */
function SharePanel({ libraryId, file }: { libraryId: string; file: FileSummary }) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const resourceKey = `file:${libraryId}/${file.rel_path}`;

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const resp = await createShare(libraryId, { key: resourceKey, caps: ['read'] });
      setShareUrl(`${window.location.origin}/s/${resp.token}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [libraryId, resourceKey]);

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div data-testid="viewer-share">
      <p className="muted">
        A read-only link that anyone with the URL (and the password, if you set one) can open
        without a Cairn account. Manage links from the Sharing page.
      </p>
      <p className="viewer-share-key">
        <code>{resourceKey}</code>
      </p>
      {shareUrl ? (
        <div className="viewer-share-result">
          <label className="visually-hidden" htmlFor="viewer-share-url">
            Share link
          </label>
          <input id="viewer-share-url" className="viewer-tag-input" readOnly value={shareUrl} />
          <button type="button" className="button" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button primary-button"
          onClick={() => void create()}
          disabled={busy}
          data-testid="viewer-create-share"
        >
          {busy ? 'Creating…' : 'Create a read-only link'}
        </button>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
