import { describe, expect, it } from 'vitest';

import type { Folder } from '../../api/types';
import { folderCountLabel } from './folderCount';

const base: Folder = { id: 'a', rel_path: 'a', name: 'a', file_count: 0 };

describe('folderCountLabel', () => {
  it('counts an indexed folder', () => {
    expect(folderCountLabel({ ...base, file_count: 1 })).toBe('1 item');
    expect(folderCountLabel({ ...base, file_count: 6174 })).toBe('6,174 items');
  });

  it('does not call a folder the scan has not reached empty', () => {
    expect(folderCountLabel({ ...base, index_state: 'waiting' })).toBe('Waiting to be indexed');
    expect(folderCountLabel({ ...base, index_state: 'waiting', index_total: 320 })).toBe(
      'Waiting to index 320 items',
    );
  });

  it('shows how far the scan is through a folder', () => {
    expect(
      folderCountLabel({
        ...base,
        file_count: 40,
        index_state: 'scanning',
        index_total: 1200,
        index_scanned: 40,
      }),
    ).toBe('Indexing · 40 of 1,200');
  });
});
