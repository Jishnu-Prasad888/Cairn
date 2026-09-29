/**
 * The application frame: a left navigation sidebar and a top bar with the
 * global search, wrapping every routed page.
 *
 * The navigation is the one from the product spec, in the order a person meets
 * it — the media first, then the things they have organized, then the ones
 * they have made, then the housekeeping at the end. The extra entries below the
 * spec's list (Duplicates, Libraries, Permissions, ML, Backups) are grouped
 * separately because they are administration, not browsing, and a member
 * without the capability sees a 403 rather than an empty page.
 *
 * Narrow screens get a drawer rather than the icon rail: twelve icons in a
 * 72px column are indistinguishable without labels, and the labels are the
 * whole point.
 */

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/authContext';
import './AppShell.css';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  /** Match the route exactly — used for "/" so Home is not always active. */
  end?: boolean;
}

/** Material-style outline icons, drawn with the current text color. */
const iconHome = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" />
  </svg>
);

const iconPhoto = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </svg>
);

const iconVideo = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2.5" y="5" width="13" height="14" rx="2" />
    <path d="m15.5 10.5 6-3.5v10l-6-3.5z" />
  </svg>
);

const iconFile = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);

const iconMemories = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    <path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
  </svg>
);

const iconAlbums = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3.5" y="3.5" width="12" height="12" rx="2" />
    <circle cx="8" cy="8" r="1.4" />
    <path d="M10 20.5h8a2 2 0 0 0 2-2V11" />
  </svg>
);

const iconPeople = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-3.9 3.4-6 8-6s8 2.1 8 6" />
  </svg>
);

const iconTag = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 3v6.5L12.8 19.3a1.9 1.9 0 0 0 2.7 0l3.8-3.8a1.9 1.9 0 0 0 0-2.7L8.5 3H3z" />
    <circle cx="7.2" cy="7.2" r="1.3" />
  </svg>
);

const iconShare = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="17.5" cy="6" r="2.6" />
    <circle cx="6.5" cy="12" r="2.6" />
    <circle cx="17.5" cy="18" r="2.6" />
    <path d="m8.8 10.8 6.4-3.5M8.8 13.2l6.4 3.5" />
  </svg>
);

const iconStar = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m12 4 2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-3.9 5.6-.8z" />
  </svg>
);

const iconTrash = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 7h16" />
    <path d="M9 7V5h6v2" />
    <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
  </svg>
);

const iconSettings = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a1.6 1.6 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a1.6 1.6 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a1.6 1.6 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a1.6 1.6 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a1.6 1.6 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a1.6 1.6 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a1.6 1.6 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a1.6 1.6 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </svg>
);

const iconDuplicates = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
);

const iconDrive = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
    <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </svg>
);

const iconLock = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4.5" y="10" width="15" height="10.5" rx="2" />
    <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
  </svg>
);

const iconSpark = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
  </svg>
);

const iconArchive = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4" width="18" height="4.5" rx="1.4" />
    <path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5" />
    <path d="M10 12.5h4" />
  </svg>
);

const iconLogout = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M10 8l-4 4 4 4" />
    <path d="M6 12h9" />
  </svg>
);

const iconSearch = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

const iconMenu = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

/**
 * The browsing sections, in the order the product spec suggests.
 *
 * `/browse` stays reachable as the untyped browser — it is what the top-bar
 * search lands on when a query has no natural section — but it is not listed,
 * because a link labelled "Browse" next to Photos, Videos, and Files is three
 * ways to the same place and one too many.
 */
const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: iconHome, end: true },
  { to: '/photos', label: 'Photos', icon: iconPhoto },
  { to: '/videos', label: 'Videos', icon: iconVideo },
  { to: '/files', label: 'Files', icon: iconFile },
  { to: '/memories', label: 'Memories', icon: iconMemories },
  { to: '/albums', label: 'Albums', icon: iconAlbums },
  { to: '/people', label: 'People', icon: iconPeople },
  { to: '/tags', label: 'Tags', icon: iconTag },
  { to: '/shared', label: 'Shared', icon: iconShare },
  { to: '/favorites', label: 'Favorites', icon: iconStar },
  { to: '/trash', label: 'Trash', icon: iconTrash },
  { to: '/settings', label: 'Settings', icon: iconSettings },
];

/** Administration and maintenance, shown below the browsing sections. */
const ADMIN_ITEMS: NavItem[] = [
  { to: '/duplicates', label: 'Duplicates', icon: iconDuplicates },
  { to: '/libraries', label: 'Libraries', icon: iconDrive },
  { to: '/permissions', label: 'Permissions', icon: iconLock },
  { to: '/ml', label: 'Machine learning', icon: iconSpark },
  { to: '/backups', label: 'Backups', icon: iconArchive },
];

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end ?? false}
          onClick={onNavigate}
          className={({ isActive }) => (isActive ? 'app-nav-item active' : 'app-nav-item')}
        >
          <span className="app-nav-icon">{item.icon}</span>
          <span className="app-nav-label">{item.label}</span>
        </NavLink>
      ))}
    </>
  );
}

export default function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const urlQuery = new URLSearchParams(location.search).get('q') ?? '';
  const [query, setQuery] = useState(urlQuery);
  const [prevUrlQuery, setPrevUrlQuery] = useState(urlQuery);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerButtonRef = useRef<HTMLButtonElement | null>(null);

  // Keep the top-bar search in sync with the address bar. Adjust state during
  // render (React-recommended) instead of in an effect.
  if (prevUrlQuery !== urlQuery) {
    setPrevUrlQuery(urlQuery);
    setQuery(urlQuery);
  }

  // Escape closes the drawer and returns focus to the button that opened it.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setDrawerOpen(false);
      drawerButtonRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    setDrawerOpen(false);
    navigate(q ? `/browse?q=${encodeURIComponent(q)}` : '/browse');
  };

  return (
    <div className="app-shell" data-testid="app-shell">
      <button
        type="button"
        ref={drawerButtonRef}
        className="app-menu-button"
        aria-expanded={drawerOpen}
        aria-controls="app-sidebar"
        onClick={() => setDrawerOpen((open) => !open)}
        data-testid="nav-toggle"
      >
        <span className="app-menu-icon">{iconMenu}</span>
        <span className="visually-hidden">
          {drawerOpen ? 'Close navigation' : 'Open navigation'}
        </span>
      </button>

      {drawerOpen && (
        <div
          className="app-drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          data-testid="nav-backdrop"
        />
      )}

      <aside
        id="app-sidebar"
        className={drawerOpen ? 'app-sidebar open' : 'app-sidebar'}
        data-testid="app-sidebar"
      >
        <Link
          to="/"
          className="app-brand"
          aria-label="Cairn home"
          onClick={() => setDrawerOpen(false)}
        >
          <span className="app-brand-text">Cairn</span>
        </Link>

        <p className="app-sidebar-caption">Library</p>

        <nav className="app-nav" aria-label="Sections">
          <NavList items={NAV_ITEMS} onNavigate={() => setDrawerOpen(false)} />
        </nav>

        <p className="app-sidebar-caption">Upkeep</p>

        <nav className="app-nav" aria-label="Maintenance">
          <NavList items={ADMIN_ITEMS} onNavigate={() => setDrawerOpen(false)} />
        </nav>

        <div className="app-account">
          <Link
            to="/settings"
            className="app-account-user"
            title="Account settings"
            onClick={() => setDrawerOpen(false)}
          >
            <span className="app-account-initial" aria-hidden="true">
              {(user?.username ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="app-account-meta">
              <span className="app-account-name">{user?.username}</span>
              <span className="app-account-role">
                {user?.role === 'admin' ? 'Administrator' : 'Member'}
              </span>
            </span>
          </Link>
          <button
            type="button"
            className="app-signout"
            onClick={() => void logout()}
            data-testid="sign-out"
          >
            <span className="app-signout-icon">{iconLogout}</span>
            <span className="app-signout-label">Sign out</span>
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="app-topbar">
          <form className="app-search" role="search" onSubmit={onSubmit}>
            <span className="app-search-icon">{iconSearch}</span>
            <input
              type="search"
              aria-label="Search Cairn"
              placeholder="Search your media…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </form>
          <Link
            to="/settings"
            className="app-avatar"
            aria-label="Account settings"
            title="Account settings"
          >
            <span className="app-avatar-initial" aria-hidden="true">
              {(user?.username ?? '?').slice(0, 1).toUpperCase()}
            </span>
          </Link>
        </header>

        <div className="app-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
