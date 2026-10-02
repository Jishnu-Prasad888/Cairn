/**
 * The library switcher at the foot of the navigation.
 *
 * Cairn can manage several physical libraries — a photo drive, an archive, a
 * college folder — so "which one am I looking at, and is it plugged in?" has to
 * be answerable at a glance. The button names the library and carries its
 * status: offline, indexing (with a climbing count), or simply how many items
 * it holds. Choosing another library is one menu away.
 */

import { useNavigate } from 'react-router-dom';

import { useLibraries } from '../../api/libraries';
import { useAuth } from '../../auth/authContext';
import { Icon } from '../ui/Icon';
import { Menu, type MenuEntry, useMenuButton } from '../ui/Menu';
import { isIndexing, useIndexStatus } from './useIndexStatus';

const numberFormat = new Intl.NumberFormat();

export function LibrarySwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { libraries, library, selectLibrary } = useLibraries();
  const { user } = useAuth();
  const navigate = useNavigate();
  const menu = useMenuButton();
  const status = useIndexStatus(library?.id ?? null, library?.status !== 'offline');

  if (!library) return null;

  const offline = library.status === 'offline';
  const indexing = isIndexing(status);
  const count = status?.present;

  let line: string;
  if (offline) line = 'Offline · browsing saved details';
  else if (indexing)
    line = count !== undefined ? `Indexing · ${numberFormat.format(count)} items` : 'Indexing…';
  else if (count !== undefined)
    line = `${numberFormat.format(count)} ${count === 1 ? 'item' : 'items'}`;
  else line = 'Online';

  const items: MenuEntry[] = libraries.map((lib) => ({
    id: lib.id,
    label: lib.status === 'offline' ? `${lib.name} (offline)` : lib.name,
    icon: lib.id === library.id ? 'check' : lib.status === 'offline' ? 'drive-off' : 'drive',
    onSelect: () => {
      selectLibrary(lib.id);
      onNavigate?.();
    },
  }));
  if (user?.role === 'admin') {
    items.push('separator', {
      id: 'manage',
      label: 'Manage libraries',
      icon: 'settings',
      onSelect: () => {
        navigate('/libraries');
        onNavigate?.();
      },
    });
  }

  return (
    <div className="library-switcher" data-testid="library-switcher">
      <button
        type="button"
        className={offline ? 'library-switcher-button is-offline' : 'library-switcher-button'}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <span className="library-switcher-icon" aria-hidden="true">
          <Icon name={offline ? 'drive-off' : 'drive'} size={18} />
        </span>
        <span className="library-switcher-text">
          <span className="library-switcher-label">Library</span>
          <span className="library-switcher-name">{library.name}</span>
          <span className="library-switcher-status" data-testid="library-status-line">
            {line}
          </span>
        </span>
        <Icon name="chevron-down" size={16} />
      </button>
      {indexing && (
        <div className="progress progress-indeterminate" aria-hidden="true">
          <div className="progress-fill" />
        </div>
      )}
      {menu.anchor && (
        <Menu anchor={menu.anchor} items={items} onClose={menu.close} label="Switch library" />
      )}
    </div>
  );
}
