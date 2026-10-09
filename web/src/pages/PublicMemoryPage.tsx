/**
 * The public view of one shared memory — fetched once the share link is
 * already unlocked (token + password resolved by PublicSharePage), and
 * rendered with the same presentational MemoryReader the authenticated
 * Preview mode uses. Every media URL in the response is already
 * share-relative (internal/httpapi/memories_public.go), so MemoryReader
 * needs no changes to work for an anonymous visitor.
 */

import { useEffect, useState } from 'react';

import { getPublicShareMemory } from '../memories/api';
import { MemoryReader } from '../memories/MemoryReader';
import type { MemoryDocument } from '../memories/types';
import { ErrorState, LoadingState } from '../components/States';
import '../memories/memories.css';

/** No per-visitor settings on a public link; this matches the documented default. */
const DEFAULT_SLIDESHOW_INTERVAL = 15;

type Settled = { kind: 'ready'; memory: MemoryDocument } | { kind: 'error'; message: string };

export function PublicMemoryPage({
  token,
  password,
}: {
  token: string;
  password: string | undefined;
}) {
  // Tagged with what it was for, the same way PublicSharePage settles its
  // own fetches — so a `setState` inside the effect only ever reports a
  // result, never resets to "loading" as a side effect of its own body.
  const key = `${token}|${password ?? ''}`;
  const [settled, setSettled] = useState<{ key: string; value: Settled } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPublicShareMemory(token, password)
      .then((resp) => {
        if (!cancelled) setSettled({ key, value: { kind: 'ready', memory: resp.memory } });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setSettled({
            key,
            value: { kind: 'error', message: e instanceof Error ? e.message : String(e) },
          });
      });
    return () => {
      cancelled = true;
    };
  }, [key, token, password]);

  const state: Settled | { kind: 'loading' } =
    settled?.key === key ? settled.value : { kind: 'loading' };

  if (state.kind === 'loading') return <LoadingState label="Opening this memory…" />;
  if (state.kind === 'error') return <ErrorState message={state.message} />;

  const { blocks, ...meta } = state.memory;
  return <MemoryReader meta={meta} blocks={blocks} defaultInterval={DEFAULT_SLIDESHOW_INTERVAL} />;
}
