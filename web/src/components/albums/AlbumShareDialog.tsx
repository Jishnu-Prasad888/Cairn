/**
 * Sharing one album: grant specific people view or edit access, or make it
 * public so anyone with the link can see it without an account. Both are the
 * same capability-grant system the Permissions and Sharing pages use for a
 * whole library, scoped here to this one album's resource key
 * (`<library>/a:<album>`) instead.
 */

import { useCallback, useMemo, useState } from 'react';

import { useAuth } from '../../auth/authContext';
import { useResource } from '../../api/resources';
import {
  createGrant,
  createShare,
  listGrants,
  listShares,
  listUsers,
  revokeGrant,
  revokeShare,
} from '../../api/queries';
import type { Album, Capability, PermissionGrant, Share } from '../../api/types';
import { Dialog } from '../Dialog';
import './AlbumShareDialog.css';

type AccessLevel = 'view' | 'edit';

/**
 * `read` alone only covers listing and thumbnails — the viewer's full-size
 * image and video playback goes through the same download route a literal
 * save does, so "view" has to carry `download` too or opening a photo in the
 * album just 403s silently.
 */
const CAPS: Record<AccessLevel, Capability[]> = {
  view: ['read', 'download'],
  edit: ['read', 'download', 'edit'],
};

function levelOf(caps: Capability[]): AccessLevel {
  return caps.includes('edit') ? 'edit' : 'view';
}

/** Expired or revoked shares are not offered as "the" active public link. */
function isActive(share: Share): boolean {
  if (share.revoked_at) return false;
  if (!share.expires_at) return true;
  return Date.parse(share.expires_at) >= Date.now();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AlbumShareDialog({
  libraryId,
  album,
  onClose,
}: {
  libraryId: string;
  album: Album;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const key = `${libraryId}/a:${album.id}`;

  const grants = useResource(
    useCallback(
      async () =>
        (await listGrants(libraryId)).grants?.filter((g) => g.resource_key === key) ?? [],
      [libraryId, key],
    ),
  );
  const shares = useResource(
    useCallback(
      async () =>
        (await listShares(libraryId)).shares?.filter((s) => s.resource_key === key) ?? [],
      [libraryId, key],
    ),
  );
  const users = useResource(useCallback(() => listUsers(), []), [], isAdmin);
  const userNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users.data?.users ?? []) map.set(u.id, u.username);
    return map;
  }, [users.data]);

  const [userId, setUserId] = useState('');
  const [level, setLevel] = useState<AccessLevel>('view');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [togglingOff, setTogglingOff] = useState(false);

  const activeShare = shares.data?.find(isActive) ?? null;

  const addPerson = () => {
    const id = userId.trim();
    if (!id) return;
    setAdding(true);
    setAddError(null);
    createGrant(libraryId, { user_id: id, key, caps: CAPS[level], effect: 'allow' })
      .then(() => {
        setUserId('');
        setLevel('view');
        grants.reload();
      })
      .catch((e: unknown) => setAddError(message(e)))
      .finally(() => setAdding(false));
  };

  const removePerson = (grant: PermissionGrant) => {
    setRemovingId(grant.id);
    setAddError(null);
    revokeGrant(libraryId, grant.id)
      .then(() => grants.reload())
      .catch((e: unknown) => setAddError(message(e)))
      .finally(() => setRemovingId(null));
  };

  const makePublic = () => {
    setPublishing(true);
    setPublishError(null);
    createShare(libraryId, { key, caps: CAPS.view })
      .then((resp) => {
        setFresh({ url: `${window.location.origin}/s/${resp.token}` });
        setCopied(false);
        shares.reload();
      })
      .catch((e: unknown) => setPublishError(message(e)))
      .finally(() => setPublishing(false));
  };

  const turnOffPublic = () => {
    if (!activeShare) return;
    setTogglingOff(true);
    setPublishError(null);
    revokeShare(libraryId, activeShare.id)
      .then(() => {
        setFresh(null);
        shares.reload();
      })
      .catch((e: unknown) => setPublishError(message(e)))
      .finally(() => setTogglingOff(false));
  };

  const copyFresh = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const knownUserIds = new Set(grants.data?.map((g) => g.user_id));

  return (
    <Dialog
      open
      size="medium"
      title={`Share "${album.name}"`}
      onClose={onClose}
      testId="album-share-dialog"
      footer={
        <button type="button" className="button" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="album-share">
        <section className="album-share-section">
          <h3>People with access</h3>
          {grants.error && (
            <p className="error-text" role="alert">
              {grants.error}
            </p>
          )}
          {grants.loading && <p className="muted">Loading…</p>}
          {grants.data !== null && grants.data.length === 0 && (
            <p className="muted">Nobody else has been given access to this album yet.</p>
          )}
          {grants.data !== null && grants.data.length > 0 && (
            <ul className="album-share-people" data-testid="album-share-people">
              {grants.data.map((grant) => (
                <li key={grant.id} className="album-share-person">
                  <span className="album-share-person-name">
                    {userNames.get(grant.user_id) ?? grant.user_id}
                  </span>
                  <span className="tag-chip">
                    {levelOf(grant.capabilities) === 'edit' ? 'Can edit' : 'Can view'}
                  </span>
                  <button
                    type="button"
                    className="button ghost-button"
                    onClick={() => removePerson(grant)}
                    disabled={removingId === grant.id}
                    data-testid={`revoke-album-grant-${grant.id}`}
                  >
                    {removingId === grant.id ? 'Removing…' : 'Remove'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="album-share-add">
            {isAdmin && users.data ? (
              <select
                className="album-share-input"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                aria-label="Add a person"
                data-testid="album-share-user"
              >
                <option value="">Choose a person…</option>
                {(users.data.users ?? [])
                  .filter((u) => u.id !== user?.id && !knownUserIds.has(u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username}
                    </option>
                  ))}
              </select>
            ) : (
              <input
                className="album-share-input"
                placeholder="User ID"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                aria-label="User ID to add"
                data-testid="album-share-user-id"
              />
            )}
            <div className="segmented" role="radiogroup" aria-label="Access level">
              {(['view', 'edit'] as const).map((l) => (
                <label
                  key={l}
                  className={level === l ? 'segmented-item active' : 'segmented-item'}
                >
                  <input
                    type="radio"
                    name="album-share-level"
                    className="visually-hidden"
                    checked={level === l}
                    onChange={() => setLevel(l)}
                  />
                  <span>{l === 'view' ? 'Can view' : 'Can edit'}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="button primary-button"
              onClick={addPerson}
              disabled={adding || userId.trim() === ''}
              data-testid="confirm-album-share"
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
          </div>
          {addError && (
            <p className="error-text" role="alert">
              {addError}
            </p>
          )}
        </section>

        <section className="album-share-section">
          <h3>Public link</h3>
          {shares.error && (
            <p className="error-text" role="alert">
              {shares.error}
            </p>
          )}

          {!activeShare && !fresh && (
            <>
              <p className="muted">
                Anyone with the link can view this album without signing in.
              </p>
              <button
                type="button"
                className="button"
                onClick={makePublic}
                disabled={publishing || shares.loading}
                data-testid="make-album-public"
              >
                {publishing ? 'Creating…' : 'Make public'}
              </button>
            </>
          )}

          {fresh && (
            <div className="album-share-fresh" role="status">
              <p className="muted">
                This is the only time the link is shown — copy it now. If it is lost, turn public
                access off and make a new one.
              </p>
              <div className="album-share-fresh-row">
                <label className="visually-hidden" htmlFor="album-public-url">
                  Public link
                </label>
                <input
                  id="album-public-url"
                  className="album-share-input"
                  readOnly
                  value={fresh.url}
                  data-testid="album-public-url"
                />
                <button type="button" className="button" onClick={() => void copyFresh()}>
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </div>
          )}

          {activeShare && !fresh && (
            <>
              <p className="muted">This album is public — anyone with the link can view it.</p>
              <button
                type="button"
                className="button danger-button"
                onClick={turnOffPublic}
                disabled={togglingOff}
                data-testid="turn-off-album-public"
              >
                {togglingOff ? 'Turning off…' : 'Turn off public access'}
              </button>
            </>
          )}
          {publishError && (
            <p className="error-text" role="alert">
              {publishError}
            </p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
