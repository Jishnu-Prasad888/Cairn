/**
 * Where a person was inside a section, so its nav link takes them back there.
 *
 * Files remembers the folder and Albums the open album: leaving for Settings
 * and clicking Files again returns to the same folder instead of the top.
 * Clicking a section's link while already inside it still goes to its top.
 *
 * Kept per tab session (a reload keeps it, a new tab or sign-in starts fresh),
 * and tied to the library that was primary at the time, since folders and
 * albums belong to one library.
 */

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import { useLibraries } from '../../api/libraries';

/** Sections whose last location is remembered. */
export const REMEMBERED_SECTIONS = ['/files', '/albums'] as const;

const KEY = 'cairn.nav.last';

interface Entry {
  url: string;
  libraryId: string | null;
}

/** The remembered section `pathname` belongs to, if any. */
function sectionOf(pathname: string): string | undefined {
  return REMEMBERED_SECTIONS.find((s) => pathname === s || pathname.startsWith(`${s}/`));
}

function read(): Record<string, Entry> {
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

function write(entries: Record<string, Entry>) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable: links simply go to the top of each section.
  }
}

/** Records the current location under its section. Mount once, in the shell. */
export function useRememberSectionLocation() {
  const { pathname, search } = useLocation();
  const { libraryId } = useLibraries();
  useEffect(() => {
    const section = sectionOf(pathname);
    if (!section) return;
    const entries = read();
    entries[section] = { url: pathname + search, libraryId: libraryId ?? null };
    write(entries);
  }, [pathname, search, libraryId]);
}

/**
 * Where a nav link to `to` should lead: the remembered location when the
 * person is elsewhere, the section's top when they are already in it.
 */
export function useSectionLink(to: string): string {
  const { pathname } = useLocation();
  const { libraryId } = useLibraries();
  const section = sectionOf(to);
  if (!section || sectionOf(pathname) === section) return to;
  const entry = read()[section];
  // An entry made before the libraries had loaded belongs to no library in
  // particular; one made for another library would open the wrong folder.
  if (!entry || (entry.libraryId && libraryId && entry.libraryId !== libraryId)) return to;
  return entry.url;
}
