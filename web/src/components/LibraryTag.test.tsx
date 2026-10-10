import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { libraryFixture, mockApi, originalFetch, renderPage } from '../test/harness';
import { LibraryTag } from './LibraryTag';

describe('LibraryTag', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    localStorage.clear();
  });

  it('names the library of an item when several libraries are open', async () => {
    mockApi([], {
      libraries: [libraryFixture(), libraryFixture({ id: 'lib2', name: 'Archive' })],
    });
    localStorage.setItem('cairn.library', 'lib1');
    localStorage.setItem('cairn.libraries.open', JSON.stringify(['lib1', 'lib2']));

    renderPage(<LibraryTag libraryId="lib2" />);

    const tag = await screen.findByTestId('library-tag');
    expect(tag).toHaveTextContent('Archive');
    expect(tag).toHaveAttribute('data-library-id', 'lib2');
  });

  it('stays invisible with a single open library', async () => {
    mockApi([]);
    renderPage(<LibraryTag libraryId="lib1" />);

    expect(screen.queryByTestId('library-tag')).not.toBeInTheDocument();
  });
});