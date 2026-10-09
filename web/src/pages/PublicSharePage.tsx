/**
 * The public view behind a share link — `/s/:token`.
 *
 * This route is deliberately outside the app shell and outside `RequireAuth`:
 * the token in the URL *is* the credential, so requiring a session would make
 * every share link unusable for the people it was made for. The page therefore
 * has no library, no chrome, and no session — just what the share exposes.
 *
 * A share that has a password needs unlocking before the file list is visible.
 * The password travels in the `X-Cairn-Share-Password` header on every request
 * and is kept in component state only; it is never written to storage, because
 * putting a share credential in localStorage outlives the decision to share.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { ApiError } from '../api/client';
import {
  downloadPublicShareFile,
  getPublicShare,
  listPublicShareFiles,
  publicShareDownloadUrl,
  publicShareThumbnailUrl,
} from '../api/queries';
import type { FileSummary, PublicShareInfo } from '../api/types';
import { isPreviewable, mediaTypeIcon } from '../components/media';
import { Icon } from '../components/ui/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { PublicMemoryPage } from './PublicMemoryPage';
import './PublicSharePage.css';

type ShareState =
  | { kind: 'loading' }
  | { kind: 'denied'; message: string; needsPassword: boolean }
  | { kind: 'unlocked'; share: PublicShareInfo };

export default function PublicSharePage() {
  const { token = '' } = useParams();
  const [searchParams] = useSearchParams();

  const [password, setPassword] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // A share can be scoped to a subfolder; the link the owner copies carries it.
  const folder = searchParams.get('folder') ?? '';

  // Both requests are tagged with what they were for, so a new token or a new
  // password invalidates the previous answer by comparison. That is what keeps
  // a wrong password from leaving the previous share's files on screen while
  // the retry is in flight.
  const shareKey = `${token}|${unlocked ? password : ''}`;
  const [settledShare, setSettledShare] = useState<{
    key: string;
    value: Exclude<ShareState, { kind: 'loading' }>;
  } | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    getPublicShare(token, unlocked ? password : undefined)
      .then((resp) => {
        if (!cancelled)
          setSettledShare({ key: shareKey, value: { kind: 'unlocked', share: resp.share } });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const unauthorized = e instanceof ApiError && e.status === 401;
        setSettledShare({
          key: shareKey,
          value: {
            kind: 'denied',
            message: unauthorized
              ? 'This share needs a password.'
              : e instanceof Error
                ? e.message
                : String(e),
            // A 401 without a password attempted is almost always a wrong or
            // missing password; either way the only useful move is to ask.
            needsPassword: true,
          },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [shareKey, token, unlocked, password]);

  const state: ShareState =
    token === ''
      ? { kind: 'denied', message: 'This link is missing its share token.', needsPassword: false }
      : settledShare?.key === shareKey
        ? settledShare.value
        : { kind: 'loading' };

  // A memory share's content is a block document, not a file listing — it
  // never touches the files endpoint at all. A file share lists exactly one
  // file and skips the grid, going straight to the single-item viewer below.
  const isMemoryShare = state.kind === 'unlocked' && state.share.resource_type === 'memory';
  const isFileShare = state.kind === 'unlocked' && state.share.resource_type === 'file';

  // The first page is derived from the fetch; "load more" appends to `extra`.
  const filesKey = state.kind === 'unlocked' && !isMemoryShare ? `${shareKey}|${folder}` : null;
  const [settledFiles, setSettledFiles] = useState<
    | {
        key: string;
        value: { files: FileSummary[]; next?: string | undefined };
      }
    | { key: string; error: string }
    | null
  >(null);
  const [extra, setExtra] = useState<FileSummary[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (filesKey === null) return;
    let cancelled = false;
    listPublicShareFiles(token, unlocked ? password : undefined, { folder, limit: 200 })
      .then((page) => {
        if (cancelled) return;
        setSettledFiles({
          key: filesKey,
          value: { files: page.files ?? [], next: page.next_cursor },
        });
        setExtra([]);
        setCursor(page.next_cursor);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSettledFiles({ key: filesKey, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [filesKey, token, password, unlocked, folder]);

  const currentFiles = filesKey !== null && settledFiles?.key === filesKey ? settledFiles : null;
  const files = [
    ...(currentFiles && 'value' in currentFiles ? currentFiles.value.files : []),
    ...extra,
  ];
  const filesError = currentFiles && 'error' in currentFiles ? currentFiles.error : null;
  const filesLoading = (filesKey !== null && currentFiles === null) || loadingMore;

  const loadMore = useCallback(async () => {
    if (filesKey === null || !cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listPublicShareFiles(token, unlocked ? password : undefined, {
        folder,
        limit: 200,
        cursor,
      });
      setExtra((prev) => [...prev, ...(page.files ?? [])]);
      setCursor(page.next_cursor);
    } catch {
      // The next cursor is unchanged, so "Load more" stays available.
    } finally {
      setLoadingMore(false);
    }
  }, [filesKey, cursor, loadingMore, token, password, unlocked, folder]);

  const submitPassword = (event: React.FormEvent) => {
    event.preventDefault();
    setUnlocked(true);
  };

  const download = async (file: FileSummary) => {
    setDownloading(file.id);
    setDownloadError(null);
    try {
      await downloadPublicShareFile(token, file.id, file.name, unlocked ? password : undefined);
    } catch (e: unknown) {
      setDownloadError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(null);
    }
  };

  // The grid looks like the authenticated album/folder grid; opening a tile
  // behaves like the authenticated viewer, minus everything that needs an
  // account (favorites, tags, editing) — just the photo, prev/next, and
  // download, which is all a visitor with no session can do here.
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  // A file share has nothing to browse — its one file is "open" as soon as
  // it's loaded, with no grid behind it to return to (there's no close
  // button in that mode, so viewerIndex itself never needs to change here).
  const activeViewerIndex =
    viewerIndex !== null ? viewerIndex : isFileShare && files.length > 0 ? 0 : null;
  const viewerFile = activeViewerIndex !== null ? files[activeViewerIndex] : undefined;
  const sharePassword = unlocked ? password : undefined;

  // A failed video/image load (expired share, revoked access, unsupported
  // format) otherwise fails completely silently — the element just sits
  // there showing nothing, which looks identical to "still loading". Keyed
  // by file id rather than cleared on navigation, so moving to a different
  // file naturally stops showing a stale error without needing an effect.
  const [mediaError, setMediaError] = useState<{ fileId: string; message: string } | null>(null);
  const viewerMediaError =
    viewerFile && mediaError?.fileId === viewerFile.id ? mediaError.message : null;

  useEffect(() => {
    if (viewerIndex === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewerIndex(null);
      else if (event.key === 'ArrowLeft') setViewerIndex((i) => (i && i > 0 ? i - 1 : i));
      else if (event.key === 'ArrowRight')
        setViewerIndex((i) => (i !== null && i < files.length - 1 ? i + 1 : i));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewerIndex, files.length]);

  return (
    <main className="share-view" data-testid="public-share-page">
      <header className="share-view-header">
        <span className="brand share-brand">Cairn</span>
        {state.kind === 'unlocked' && state.share.library && (
          <p className="muted">Shared from {state.share.library}</p>
        )}
      </header>

      {state.kind === 'loading' && <LoadingState label="Opening this share…" />}

      {state.kind === 'denied' && (
        <section className="share-gate" aria-labelledby="share-gate-title">
          <h1 id="share-gate-title">This share is locked</h1>
          <p className="muted">{state.message}</p>
          {state.needsPassword && (
            <form className="share-gate-form" onSubmit={submitPassword}>
              <label htmlFor="share-password">Password</label>
              <div className="share-gate-row">
                <input
                  id="share-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                  data-testid="share-password-input"
                />
                <button type="submit" className="button primary-button" data-testid="share-unlock">
                  Open
                </button>
              </div>
            </form>
          )}
          <p className="muted share-gate-note">
            Shares are capabilities, not accounts. If this link should not be working, ask the
            person who shared it to make a new one — a lost token cannot be recovered.
          </p>
        </section>
      )}

      {state.kind === 'unlocked' && isMemoryShare && (
        <PublicMemoryPage token={token} password={sharePassword} />
      )}

      {state.kind === 'unlocked' && !isMemoryShare && (
        <>
          {!isFileShare && (
            <h1 className="share-view-title">
              {state.share.resource_key}
              {folder && <span className="muted"> — {folder}</span>}
            </h1>
          )}
          {state.share.expires_at && (
            <p className="muted">
              This link expires on{' '}
              <time dateTime={state.share.expires_at}>
                {new Date(state.share.expires_at).toLocaleDateString()}
              </time>
              .
            </p>
          )}

          {filesError && <ErrorState message={filesError} />}
          {downloadError && (
            <p className="error-text" role="alert">
              {downloadError}
            </p>
          )}
          {filesLoading && files.length === 0 && <LoadingState label="Loading files…" />}

          {!isFileShare && files.length === 0 && !filesLoading && !filesError && (
            <EmptyState title="Nothing here" testId="share-empty">
              <p className="muted">This share is empty, or everything in it has been removed.</p>
            </EmptyState>
          )}

          {/* Only rendered once there is something in it: an empty list is
              announced as a section with nothing in it. A file share skips
              the grid entirely — the viewer below opens on its own file. */}
          {!isFileShare && files.length > 0 && (
            <ul className="share-grid" data-testid="share-file-list">
              {files.map((file, index) => (
                <li key={file.id}>
                  <div className="share-tile">
                    <button
                      type="button"
                      className="share-tile-main"
                      onClick={() => setViewerIndex(index)}
                    >
                      {isPreviewable(file) ? (
                        <img
                          className="share-tile-img"
                          src={publicShareThumbnailUrl(token, file.id, sharePassword)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          onLoad={(event) => {
                            event.currentTarget.dataset.loaded = 'true';
                          }}
                          onError={(event) => {
                            event.currentTarget.hidden = true;
                          }}
                        />
                      ) : null}
                      <span className="share-tile-glyph" aria-hidden="true">
                        <Icon name={mediaTypeIcon(file.media_type)} size={26} />
                      </span>
                      {file.media_type === 'video' && (
                        <span className="share-tile-badge" aria-hidden="true">
                          <Icon name="play" size={14} filled />
                        </span>
                      )}
                      <span className="share-tile-caption">{file.name}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button share-tile-download"
                      aria-label={`Download ${file.name}`}
                      onClick={() => void download(file)}
                      disabled={downloading === file.id}
                      data-testid={`download-${file.id}`}
                    >
                      <Icon name="download" size={16} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {cursor && (
            <div className="share-pagination">
              <button
                type="button"
                className="button"
                onClick={() => void loadMore()}
                disabled={filesLoading}
                data-testid="share-load-more"
              >
                {filesLoading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {viewerFile && (
        <div className="share-viewer" role="dialog" aria-modal="true" aria-label={viewerFile.name}>
          {!isFileShare && (
            <button
              type="button"
              className="icon-button share-viewer-close"
              aria-label="Close"
              onClick={() => setViewerIndex(null)}
            >
              <Icon name="close" />
            </button>
          )}

          {viewerIndex! > 0 && (
            <button
              type="button"
              className="icon-button share-viewer-nav share-viewer-prev"
              aria-label="Previous"
              onClick={() => setViewerIndex((i) => (i ? i - 1 : i))}
            >
              <Icon name="chevron-left" />
            </button>
          )}
          {viewerIndex! < files.length - 1 && (
            <button
              type="button"
              className="icon-button share-viewer-nav share-viewer-next"
              aria-label="Next"
              onClick={() => setViewerIndex((i) => (i !== null ? i + 1 : i))}
            >
              <Icon name="chevron-right" />
            </button>
          )}

          <div className="share-viewer-stage">
            {viewerMediaError ? (
              <div className="share-viewer-fallback">
                <Icon name={mediaTypeIcon(viewerFile.media_type)} size={48} />
                <p className="muted">{viewerMediaError}</p>
              </div>
            ) : viewerFile.media_type === 'video' ? (
              <video
                key={viewerFile.id}
                className="share-viewer-media"
                src={publicShareDownloadUrl(token, viewerFile.id, sharePassword)}
                controls
                playsInline
                preload="metadata"
                onClick={(event) => {
                  const video = event.currentTarget;
                  if (video.paused) void video.play();
                  else video.pause();
                }}
                onError={(event) => {
                  const err = event.currentTarget.error;
                  setMediaError({
                    fileId: viewerFile.id,
                    message:
                      err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
                        ? 'This video format cannot be played in the browser.'
                        : 'This video could not be loaded. The link may have expired or access may have been revoked.',
                  });
                }}
              />
            ) : isPreviewable(viewerFile) ? (
              <img
                className="share-viewer-media"
                src={publicShareDownloadUrl(token, viewerFile.id, sharePassword)}
                alt={viewerFile.name}
                onError={() =>
                  setMediaError({
                    fileId: viewerFile.id,
                    message:
                      'This image could not be loaded. The link may have expired or access may have been revoked.',
                  })
                }
              />
            ) : (
              <div className="share-viewer-fallback">
                <Icon name={mediaTypeIcon(viewerFile.media_type)} size={48} />
              </div>
            )}
          </div>

          <div className="share-viewer-footer">
            <span className="share-viewer-name">{viewerFile.name}</span>
            <button
              type="button"
              className="button"
              onClick={() => void download(viewerFile)}
              disabled={downloading === viewerFile.id}
            >
              {downloading === viewerFile.id ? 'Downloading…' : 'Download'}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
