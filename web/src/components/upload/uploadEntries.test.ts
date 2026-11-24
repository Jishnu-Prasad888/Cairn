import { describe, expect, it } from 'vitest';

import { entriesFromDrop, entriesFromFiles } from './uploadEntries';

// A minimal stand-in for the browser's FileSystemEntry tree.
function fileEntry(name: string) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => ok(new File(['x'], name)),
  };
}
function dirEntry(name: string, children: unknown[]) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let done = false;
      // Entries arrive in batches until an empty one, like the real API.
      return {
        readEntries: (ok: (e: unknown[]) => void) => {
          ok(done ? [] : children);
          done = true;
        },
      };
    },
  };
}
function transfer(entries: unknown[]): DataTransfer {
  return {
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry })),
    files: [],
  } as unknown as DataTransfer;
}

describe('entriesFromDrop', () => {
  it('walks a dropped folder and keeps its structure, skipping hidden files', async () => {
    const drop = transfer([
      dirEntry('books to read', [
        fileEntry('dune.pdf'),
        fileEntry('.DS_Store'),
        dirEntry('fiction', [fileEntry('emma.epub')]),
      ]),
      fileEntry('loose.jpg'),
    ]);
    const entries = await entriesFromDrop(drop);
    expect(entries?.map((e) => e.relPath)).toEqual([
      'books to read/dune.pdf',
      'books to read/fiction/emma.epub',
      'loose.jpg',
    ]);
  });

  it('falls back when the browser has no entries API', async () => {
    const drop = { items: [{ kind: 'file' }], files: [] } as unknown as DataTransfer;
    expect(await entriesFromDrop(drop)).toBeNull();
  });
});

describe('entriesFromFiles', () => {
  it('uses the picked folder path when there is one', () => {
    const inFolder = new File(['x'], 'a.jpg');
    Object.defineProperty(inFolder, 'webkitRelativePath', { value: 'Trip/a.jpg' });
    const loose = new File(['x'], 'b.jpg');
    expect(entriesFromFiles([inFolder, loose]).map((e) => e.relPath)).toEqual([
      'Trip/a.jpg',
      'b.jpg',
    ]);
  });
});
