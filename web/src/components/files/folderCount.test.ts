import { describe, expect, it } from 'vitest';

import type { Folder } from '../../api/types';
import { folderCountLabel, sortFolders } from './folderCount';

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

describe('sortFolders', () => {
  const folders: Folder[] = [
    { ...base, id: 'b', name: 'Beta', mod_time: '2024-03-01T00:00:00Z', size_bytes: 10 },
    { ...base, id: 'a', name: 'alpha', mod_time: '2025-01-01T00:00:00Z', size_bytes: 5 },
    { ...base, id: 'e', name: 'Empty' },
    { ...base, id: 'c', name: 'Gamma', mod_time: '2023-01-01T00:00:00Z', size_bytes: 99 },
  ];
  const names = (list: Folder[]) => list.map((f) => f.name);

  it('orders by newest file, undated last either way', () => {
    expect(names(sortFolders(folders, 'mod_time', 'desc'))).toEqual([
      'alpha',
      'Beta',
      'Gamma',
      'Empty',
    ]);
    expect(names(sortFolders(folders, 'mod_time', 'asc'))).toEqual([
      'Gamma',
      'Beta',
      'alpha',
      'Empty',
    ]);
  });

  it('orders by size and by name', () => {
    expect(names(sortFolders(folders, 'size', 'desc'))).toEqual([
      'Gamma',
      'Beta',
      'alpha',
      'Empty',
    ]);
    expect(names(sortFolders(folders, 'name', 'desc'))).toEqual([
      'Gamma',
      'Empty',
      'Beta',
      'alpha',
    ]);
  });
});
