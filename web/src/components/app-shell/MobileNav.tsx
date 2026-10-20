/**
 * The bottom bar on phones and tablets: the four places people go most, and
 * "More" for everything else (it opens the full navigation as a drawer).
 * Big, thumb-reachable targets; labels always shown.
 */

import type { RefObject } from 'react';
import { NavLink } from 'react-router-dom';

import { Icon } from '../ui/Icon';
import { MOBILE_NAV, type NavItem } from './navigation';
import { useSectionLink } from './sectionMemory';

function MobileNavEntry({ item }: { item: NavItem }) {
  const to = useSectionLink(item.to);
  return (
    <NavLink
      to={to}
      end={item.end ?? false}
      className={({ isActive }) => (isActive ? 'mobile-nav-item active' : 'mobile-nav-item')}
    >
      <span className="mobile-nav-pill">
        <Icon name={item.icon} size={22} />
      </span>
      <span className="mobile-nav-label">{item.label}</span>
    </NavLink>
  );
}

export function MobileNav({
  moreOpen,
  onMore,
  moreRef,
}: {
  moreOpen: boolean;
  onMore: () => void;
  moreRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <nav className="mobile-nav" aria-label="Primary">
      {MOBILE_NAV.map((item) => (
        <MobileNavEntry key={item.to} item={item} />
      ))}
      <button
        type="button"
        ref={moreRef}
        className={moreOpen ? 'mobile-nav-item active' : 'mobile-nav-item'}
        aria-expanded={moreOpen}
        aria-controls="app-sidebar"
        onClick={onMore}
        data-testid="nav-toggle"
      >
        <span className="mobile-nav-pill">
          <Icon name="menu" size={22} />
        </span>
        <span className="mobile-nav-label">More</span>
        <span className="visually-hidden">{moreOpen ? 'Close navigation' : 'Open navigation'}</span>
      </button>
    </nav>
  );
}
