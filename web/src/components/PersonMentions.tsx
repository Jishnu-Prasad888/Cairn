/**
 * `[Ritesh]` in a caption, note or memory links to Ritesh on the People page.
 *
 * `usePeopleIndex` loads the library's named people once (shared by every
 * caption on screen) for the Markdown renderer to match against, and
 * `useMentionLinks` makes the links behave: clicking one asks first — leaving
 * a photo or a memory is a bigger step than a click usually is — and then
 * opens that person.
 */

import { useCallback, useEffect, useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';

import { mlWorthAsking } from '../api/mlSwitch';
import { listPeople } from '../api/queries';
import { peopleIndex, type MentionPerson, type PeopleIndex } from '../lib/markdown';
import { ConfirmDialog } from './Dialog';

const cache = new Map<string, Promise<PeopleIndex>>();

function loadPeople(libraryId: string): Promise<PeopleIndex> {
  let pending = cache.get(libraryId);
  if (!pending) {
    pending = (async () => {
      // People come from face recognition; with ML off there are none to ask for.
      if (!(await mlWorthAsking())) return peopleIndex([]);
      const resp = await listPeople(libraryId);
      return peopleIndex(resp.people ?? []);
    })().catch(() => {
      // Try again next time rather than caching the failure.
      cache.delete(libraryId);
      return peopleIndex([]);
    });
    cache.set(libraryId, pending);
    // Names change (people are renamed, merged): look again after a while.
    setTimeout(() => cache.delete(libraryId), 60_000);
  }
  return pending;
}

/** Forget the cached names, e.g. after renaming someone. */
export function forgetPeopleIndex(libraryId?: string) {
  if (libraryId) cache.delete(libraryId);
  else cache.clear();
}

/** The library's named people, for `renderMarkdown(body, { people })`. */
export function usePeopleIndex(libraryId: string | undefined | null): PeopleIndex | undefined {
  const [state, setState] = useState<{ id: string; index: PeopleIndex } | null>(null);
  useEffect(() => {
    if (!libraryId) return;
    let cancelled = false;
    void loadPeople(libraryId).then((index) => {
      if (!cancelled) setState({ id: libraryId, index });
    });
    return () => {
      cancelled = true;
    };
  }, [libraryId]);
  return state && state.id === libraryId ? state.index : undefined;
}

/**
 * Click handling for rendered mentions. Put `onClick` on the element that
 * holds the rendered Markdown and render `dialog` next to it.
 */
export function useMentionLinks(): {
  onClick: (event: MouseEvent<HTMLElement>) => void;
  dialog: ReactElement;
} {
  // A reader rendered on its own (outside the app's router) still follows
  // the link, just as a full page load. Whether there is a router never
  // changes for a mounted component, so the hook order is stable.
  const inRouter = useInRouterContext();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const navigate = inRouter ? useNavigate() : (to: string) => window.location.assign(to);
  const [pending, setPending] = useState<MentionPerson | null>(null);

  const onClick = useCallback((event: MouseEvent<HTMLElement>) => {
    const link = (event.target as HTMLElement | null)?.closest?.('a.md-mention');
    if (!(link instanceof HTMLAnchorElement)) return;
    // A modified click (new tab) goes straight there, as links do.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setPending({ id: link.dataset.personId ?? '', name: link.dataset.personName ?? '' });
  }, []);

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={`Go to ${pending?.name || 'this person'}?`}
      message={<p>This opens {pending?.name || 'them'} on the People page.</p>}
      confirmLabel="Open"
      onCancel={() => setPending(null)}
      onConfirm={() => {
        if (!pending) return;
        const id = pending.id;
        setPending(null);
        navigate(`/people?person=${encodeURIComponent(id)}`);
      }}
      testId="mention-dialog"
    />
  );

  return { onClick, dialog };
}
