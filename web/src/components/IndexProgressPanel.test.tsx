import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { FolderProgress, IndexProgress } from '../api/types';
import { json, mockApi, originalFetch } from '../test/harness';
import { IndexProgressPanel } from './IndexProgressPanel';

const folder = (over: Partial<FolderProgress>): FolderProgress => ({
  path: '',
  name: '',
  files: 0,
  scanned: 0,
  media_pending: 0,
  media_failed: 0,
  status: 'done',
  ...over,
});

const scanning: IndexProgress = {
  library_id: 'lib1',
  scan: {
    phase: 'scanning',
    started_at: '2026-10-20T00:00:00Z',
    current_folder: 'Rani/2019',
    files_total: 400,
    files_scanned: 100,
  },
  scan_queued: false,
  media_pending: 12,
  media_failed: 0,
  root: folder({
    files: 400,
    scanned: 100,
    media_pending: 12,
    status: 'scanning',
    children: [
      folder({
        path: 'Rani',
        name: 'Rani',
        files: 200,
        scanned: 100,
        media_pending: 12,
        status: 'scanning',
        children: [
          folder({ path: 'Rani/2019', name: '2019', files: 50, scanned: 25, status: 'scanning' }),
        ],
      }),
      folder({ path: 'assam trip', name: 'assam trip', files: 150, status: 'waiting' }),
      folder({ path: 'books', name: 'books', files: 50, scanned: 50, status: 'done' }),
    ],
  }),
};

function setup(progress: IndexProgress) {
  mockApi([(url) => (url.includes('/index/progress') ? json({ progress }) : undefined)]);
  render(<IndexProgressPanel libraryId="lib1" name="Photos" />);
}

describe('IndexProgressPanel', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('summarises the scan and the queued thumbnails', async () => {
    setup(scanning);
    const summary = await screen.findByTestId('index-summary');
    expect(summary).toHaveTextContent('Scanning 100 of 400 files (25%)');
    expect(summary).toHaveTextContent('now in Rani/2019');
    expect(summary).toHaveTextContent('12 files waiting for metadata and thumbnails.');
    expect(within(summary).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  });

  it('shows a folder tree opened onto the folder being scanned', async () => {
    setup(scanning);
    fireEvent.click(await screen.findByTestId('index-tree-toggle'));

    const rows = screen.getAllByTestId('index-tree-row');
    const byPath = new Map(rows.map((r) => [r.getAttribute('data-path'), r]));
    // Root, its folders, and the scanned folder's parent opened to show it.
    expect([...byPath.keys()]).toEqual(['', 'Rani', 'Rani/2019', 'assam trip', 'books']);
    expect(byPath.get('')).toHaveTextContent('Photos');
    expect(byPath.get('assam trip')).toHaveAttribute('data-status', 'waiting');
    expect(byPath.get('assam trip')).toHaveTextContent('0 of 150 scanned');
    expect(byPath.get('Rani')).toHaveTextContent('50%');
    expect(byPath.get('books')).toHaveTextContent('Done');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Only unfinished' }));
    expect(
      screen.getAllByTestId('index-tree-row').map((r) => r.getAttribute('data-path')),
    ).not.toContain('books');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Rani' }));
    expect(
      screen.getAllByTestId('index-tree-row').map((r) => r.getAttribute('data-path')),
    ).not.toContain('Rani/2019');
  });

  it('says when everything is indexed', async () => {
    setup({
      library_id: 'lib1',
      scan_queued: false,
      media_pending: 0,
      media_failed: 0,
      root: folder({ files: 1204, scanned: 1204 }),
    });
    expect(await screen.findByTestId('index-summary')).toHaveTextContent(
      'All 1,204 files are indexed.',
    );
  });
});
