/**
 * What a folder tile says about its size.
 *
 * A folder's count is the files the index holds under it. During a library's
 * first scan that is only what the scan has reached so far, so a folder of
 * thousands it has not got to yet would read "0 items". The server marks
 * such folders, and they say they are still being indexed instead.
 */

import type { Folder } from '../../api/types';

const numberFormat = new Intl.NumberFormat();

const items = (n: number) => `${numberFormat.format(n)} ${n === 1 ? 'item' : 'items'}`;

export function folderCountLabel(folder: Folder): string {
  const total = folder.index_total ?? 0;
  if (folder.index_state === 'scanning' && total > 0) {
    return `Indexing · ${numberFormat.format(folder.index_scanned ?? 0)} of ${numberFormat.format(total)}`;
  }
  if (folder.index_state === 'waiting') {
    return total > 0 ? `Waiting to index ${items(total)}` : 'Waiting to be indexed';
  }
  return items(folder.file_count);
}

/** True while the folder's count is still partial. */
export function folderIndexing(folder: Folder): boolean {
  return folder.index_state === 'waiting' || folder.index_state === 'scanning';
}
