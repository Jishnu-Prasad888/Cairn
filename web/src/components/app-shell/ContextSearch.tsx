/**
 * The page-aware top-bar search.
 *
 * The bar belongs to whatever page you are on: on the settings-style pages it
 * finds a setting, on the files, memories and albums pages it searches that
 * page's own content (landing on its own filtered view), and everywhere else
 * it is the global library search. This is why one search box in the corner
 * feels like it knows what you are doing, rather than always being the same
 * settings filter.
 */

import type { RefObject } from 'react';
import { useLocation } from 'react-router-dom';

import { type SearchScope, SearchBox } from './SearchBox';
import { SettingsSearch } from './SettingsSearch';

/** The pages where "search" means "find a setting" — everything else is media. */
const SETTINGS_PAGES = ['/settings', '/libraries', '/permissions', '/ml', '/backups'];

export function ContextSearch({
  inputRef,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const { pathname } = useLocation();
  // exactOptionalPropertyTypes: only pass the ref when there is one to pass.
  const refProps = inputRef ? { inputRef } : {};

  if (SETTINGS_PAGES.includes(pathname)) {
    return <SettingsSearch {...refProps} />;
  }

  const scope: SearchScope | undefined = pathname.startsWith('/memories')
    ? 'memories'
    : pathname.startsWith('/albums')
      ? 'albums'
      : pathname === '/files'
        ? 'files'
        : undefined;

  return <SearchBox {...(scope ? { scope } : {})} {...refProps} />;
}