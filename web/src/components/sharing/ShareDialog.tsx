/**
 * Sharing one resource — a folder, a single photo/video, an album, or a
 * memory: grant specific people view or edit access, or make it public so
 * anyone with the link can see it without an account. Every caller hands in
 * the resource's own key (built with ../../api/resourceKeys, the only
 * correct canonical form) and this dialog does the rest; the capability
 * grant/share system underneath is already generic across resource types.
 *
 * The public link is always view-only — "edit" is only ever offered for a
 * named person's grant, never a public link, since there is no token-based
 * editing in Cairn.
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
import type { Capability, PermissionGrant, Share } from '../../api/types';
import { Dialog } from '../Dialog';
import './ShareDialog.css';

type AccessLevel = 'view' | 'edit';

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

interface ShareDialogBodyProps {
  libraryId: string;
  resourceKey: string;
  /** Used in copy: "Anyone with the link can view this {resourceLabel}…" */
  resourceLabel: string;
  /** Prefixes every data-testid, e.g. "album" -> "album-share-people". */
  testIdPrefix: string;
  viewCaps: Capability[];
  editCaps: Capability[];
}

/**
 * The people-grants + public-link content, with no modal chrome of its own
 * — used both inside the Dialog-wrapped ShareDialog (opened from a menu
 * action) and embedded directly in an already-open panel (the viewer's
 * Share tab, which is one tab among several inside an existing modal, not a
 * dialog of its own).
 */
export function ShareDialogBody({
  libraryId,
  resourceKey,
  resourceLabel,
  testIdPrefix,
  viewCaps,
  editCaps,
}: ShareDialogBodyProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const grants = useResource(
    useCallback(
      async () =>
        (await listGrants(libraryId)).grants?.filter((g) => g.resource_key === resourceKey) ?? [],
      [libraryId, resourceKey],
    ),
  );
  const shares = useResource(
    useCallback(
      async () =>
        (await listShares(libraryId)).shares?.filter((s) => s.resource_key === resourceKey) ?? [],
      [libraryId, resourceKey],
    ),
  );
  const users = useResource(
    useCallback(() => listUsers(), []),
    [],
    isAdmin,
  );
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
  const caps: Record<AccessLevel, Capability[]> = { view: viewCaps, edit: editCaps };

  const addPerson = () => {
    const id = userId.trim();
    if (!id) return;
    setAdding(true);
    setAddError(null);
    createGrant(libraryId, { user_id: id, key: resourceKey, caps: caps[level], effect: 'allow' })
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
    createShare(libraryId, { key: resourceKey, caps: viewCaps })
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
  const t = (suffix: string) => `${testIdPrefix}-${suffix}`;

  return (
    <div className="share-dialog">
      <section className="share-dialog-section">
        <h3>People with access</h3>
        {grants.error && (
          <p className="error-text" role="alert">
            {grants.error}
          </p>
        )}
        {grants.loading && <p className="muted">Loading…</p>}
        {grants.data !== null && grants.data.length === 0 && (
          <p className="muted">Nobody else has been given access to this {resourceLabel} yet.</p>
        )}
        {grants.data !== null && grants.data.length > 0 && (
          <ul className="share-dialog-people" data-testid={t('share-people')}>
            {grants.data.map((grant) => (
              <li key={grant.id} className="share-dialog-person">
                <span className="share-dialog-person-name">
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
                  data-testid={`revoke-${testIdPrefix}-grant-${grant.id}`}
                >
                  {removingId === grant.id ? 'Removing…' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="share-dialog-add">
          {isAdmin && users.data ? (
            <select
              className="share-dialog-input"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              aria-label="Add a person"
              data-testid={t('share-user')}
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
              className="share-dialog-input"
              placeholder="User ID"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              aria-label="User ID to add"
              data-testid={t('share-user-id')}
            />
          )}
          <div className="segmented" role="radiogroup" aria-label="Access level">
            {(['view', 'edit'] as const).map((l) => (
              <label key={l} className={level === l ? 'segmented-item active' : 'segmented-item'}>
                <input
                  type="radio"
                  name={t('share-level')}
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
            data-testid={`confirm-${testIdPrefix}-share`}
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

      <section className="share-dialog-section">
        <h3>Public link</h3>
        {shares.error && (
          <p className="error-text" role="alert">
            {shares.error}
          </p>
        )}

        {!activeShare && !fresh && (
          <>
            <p className="muted">
              Anyone with the link can view this {resourceLabel} without signing in.
            </p>
            <button
              type="button"
              className="button"
              onClick={makePublic}
              disabled={publishing || shares.loading}
              data-testid={`make-${testIdPrefix}-public`}
            >
              {publishing ? 'Creating…' : 'Make public'}
            </button>
          </>
        )}

        {fresh && (
          <div className="share-dialog-fresh" role="status">
            <p className="muted">
              This is the only time the link is shown — copy it now. If it is lost, turn public
              access off and make a new one.
            </p>
            <div className="share-dialog-fresh-row">
              <label className="visually-hidden" htmlFor={t('public-url')}>
                Public link
              </label>
              <input
                id={t('public-url')}
                className="share-dialog-input"
                readOnly
                value={fresh.url}
                data-testid={t('public-url')}
              />
              <button type="button" className="button" onClick={() => void copyFresh()}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </div>
        )}

        {activeShare && !fresh && (
          <>
            <p className="muted">
              This {resourceLabel} is public — anyone with the link can view it.
            </p>
            <button
              type="button"
              className="button danger-button"
              onClick={turnOffPublic}
              disabled={togglingOff}
              data-testid={`turn-off-${testIdPrefix}-public`}
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
  );
}

/**
 * Dialog-wrapped ShareDialogBody, for sharing opened from a menu action
 * (album card, folder row, memory toolbar) rather than already embedded in
 * an open panel.
 */
export function ShareDialog({
  libraryId,
  resourceKey,
  title,
  resourceLabel,
  testIdPrefix,
  viewCaps,
  editCaps,
  onClose,
}: ShareDialogBodyProps & { title: string; onClose: () => void }) {
  return (
    <Dialog
      open
      size="medium"
      title={title}
      onClose={onClose}
      testId={`${testIdPrefix}-share-dialog`}
      footer={
        <button type="button" className="button" onClick={onClose}>
          Done
        </button>
      }
    >
      <ShareDialogBody
        libraryId={libraryId}
        resourceKey={resourceKey}
        resourceLabel={resourceLabel}
        testIdPrefix={testIdPrefix}
        viewCaps={viewCaps}
        editCaps={editCaps}
      />
    </Dialog>
  );
}
