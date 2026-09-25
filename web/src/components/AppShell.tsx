import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/authContext';
import './AppShell.css';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

/** Material-style outline icons, drawn with the current text color. */
const iconPhoto = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </svg>
);

const iconMemories = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    <path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
  </svg>
);

const iconPeople = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-3.9 3.4-6 8-6s8 2.1 8 6" />
  </svg>
);

const iconAlbums = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3.5" y="3.5" width="12" height="12" rx="2" />
    <circle cx="8" cy="8" r="1.4" />
    <path d="M10 20.5h8a2 2 0 0 0 2-2V11" />
  </svg>
);

const iconTag = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 3v6.5L12.8 19.3a1.9 1.9 0 0 0 2.7 0l3.8-3.8a1.9 1.9 0 0 0 0-2.7L8.5 3H3z" />
    <circle cx="7.2" cy="7.2" r="1.3" />
  </svg>
);

const iconDuplicates = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
);

const iconSettings = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
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

const iconPerson = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-3.9 3.4-6 8-6s8 2.1 8 6" />
  </svg>
);

const NAV_ITEMS: NavItem[] = [
  { to: '/browse', label: 'Photos', icon: iconPhoto },
  { to: '/memories', label: 'Memories', icon: iconMemories },
  { to: '/people', label: 'People', icon: iconPeople },
  { to: '/albums', label: 'Albums', icon: iconAlbums },
  { to: '/tags', label: 'Tags', icon: iconTag },
  { to: '/duplicates', label: 'Duplicates', icon: iconDuplicates },
  { to: '/settings', label: 'Settings', icon: iconSettings },
];

/**
 * Google Photos–style application frame: a fixed left navigation sidebar and a
 * top bar with the global search, wrapping the routed pages.
 */
export default function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const urlQuery = new URLSearchParams(location.search).get('q') ?? '';
  const [query, setQuery] = useState(urlQuery);
  const [prevUrlQuery, setPrevUrlQuery] = useState(urlQuery);

  // Keep the top-bar search in sync with the address bar. Adjust state during
  // render (React-recommended) instead of in an effect.
  if (prevUrlQuery !== urlQuery) {
    setPrevUrlQuery(urlQuery);
    setQuery(urlQuery);
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    navigate(q ? `/browse?q=${encodeURIComponent(q)}` : '/browse');
  };

  return (
    <div className="app-shell" data-testid="app-shell">
      <aside className="app-sidebar">
        <Link to="/" className="app-brand" aria-label="Cairn home">
          <span className="app-brand-text">Cairn</span>
        </Link>

        <p className="app-sidebar-caption">Library</p>

        <nav className="app-nav" aria-label="Sections">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'app-nav-item active' : 'app-nav-item')}
            >
              <span className="app-nav-icon">{item.icon}</span>
              <span className="app-nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="app-account">
          <Link to="/settings" className="app-account-user" title="Account settings">
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
            {iconPerson}
          </Link>
        </header>

        <div className="app-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
