/**
 * An album in the grid: the cover is the card. Title and count sit beneath
 * it, quietly, the way a printed album has its label on the spine.
 *
 * Rename, share, and delete live behind the "..." button in the corner, and
 * behind a right-click anywhere on the card — the same menu, two ways in.
 */

import type { Album } from '../../api/types';
import { formatDate } from '../../lib/dates';
import { thumbnailUrl } from '../media';
import { Icon } from '../ui/Icon';
import { Menu, type MenuEntry, useMenuButton, withDangerLast } from '../ui/Menu';
import './AlbumCard.css';

const numberFormat = new Intl.NumberFormat();

export function AlbumCard({
  album,
  libraryId,
  onOpen,
  onRename,
  onShare,
  onDelete,
}: {
  album: Album;
  libraryId: string;
  onOpen: (album: Album) => void;
  /** Omit all three to render a plain card with no menu (the Home preview). */
  onRename?: (album: Album) => void;
  onShare?: (album: Album) => void;
  onDelete?: (album: Album) => void;
}) {
  const menu = useMenuButton();
  const preview = album.preview_file_id ?? album.cover_file_id;
  const count = album.file_count;

  const items: MenuEntry[] = withDangerLast([
    ...(onRename
      ? [{ id: 'rename', label: 'Rename album', icon: 'edit' as const, onSelect: () => onRename(album) }]
      : []),
    ...(onShare
      ? [{ id: 'share', label: 'Share album', icon: 'share' as const, onSelect: () => onShare(album) }]
      : []),
    ...(onDelete
      ? [
          {
            id: 'delete',
            label: 'Delete album',
            icon: 'trash' as const,
            danger: true,
            onSelect: () => onDelete(album),
            testId: `delete-album-${album.id}`,
          },
        ]
      : []),
  ]);
  const hasMenu = items.length > 0;

  return (
    <div
      className="album-card"
      onContextMenu={(event) => {
        if (!hasMenu) return;
        event.preventDefault();
        menu.setAnchor({ x: event.clientX, y: event.clientY });
      }}
    >
      <button type="button" className="album-card-main" onClick={() => onOpen(album)}>
        <span className="album-card-cover">
          {preview ? (
            <img
              src={thumbnailUrl(libraryId, { id: preview })}
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
          <Icon name="album" size={32} className="album-card-placeholder" />
        </span>
        <span className="album-card-name" title={album.name}>
          {album.name}
        </span>
        <span className="album-card-meta">
          {count !== undefined
            ? `${numberFormat.format(count)} ${count === 1 ? 'item' : 'items'}`
            : `Updated ${formatDate(album.updated_at)}`}
        </span>
      </button>

      {hasMenu && (
        <button
          type="button"
          className="icon-button album-card-menu"
          aria-label={`${album.name} options`}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          onClick={menu.toggle}
          data-testid={`album-menu-${album.id}`}
        >
          <Icon name="more" size={18} />
        </button>
      )}

      {hasMenu && menu.anchor && (
        <Menu
          anchor={menu.anchor}
          align="end"
          label={`${album.name} options`}
          onClose={menu.close}
          items={items}
        />
      )}
    </div>
  );
}
