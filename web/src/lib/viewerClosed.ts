/**
 * "The viewer just closed on this file", for whichever grid shows it.
 *
 * Paging through the viewer can leave the grid far from the photo last seen.
 * The viewer's owner announces the file it closed on; the grid that holds it
 * decides whether it is out of sight and offers to scroll back (see
 * MediaGrid). The first grid to claim it handles it, so a page with several
 * grids offers it once.
 */

type Listener = (fileId: string, claim: () => boolean) => void;

const listeners = new Set<Listener>();

export function announceViewerClosed(fileId: string): void {
  let claimed = false;
  const claim = () => {
    if (claimed) return false;
    claimed = true;
    return true;
  };
  listeners.forEach((l) => l(fileId, claim));
}

export function onViewerClosed(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
