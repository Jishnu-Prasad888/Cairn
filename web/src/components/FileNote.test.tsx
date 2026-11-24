import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshMLSwitch } from '../api/mlSwitch';
import { bodyOf, json, mockApi, originalFetch, renderPage } from '../test/harness';
import { FileNote } from './FileNote';
import { forgetPeopleIndex } from './PersonMentions';

function setup(body = '') {
  const fn = mockApi([
    (url) => (url.endsWith('/api/v1/ml/settings') ? json({ enabled: true }) : undefined),
    (url) =>
      url.endsWith('/api/v1/libraries/lib1/people')
        ? json({ people: [{ id: 'p1', name: 'Ritesh', face_count: 3 }] })
        : undefined,
    (url, init) =>
      url.endsWith('/files/f1/note') && init?.method === 'PUT'
        ? json({
            note: { file_id: 'f1', body: JSON.parse(String(init.body)).body, updated_at: '' },
          })
        : undefined,
    (url) =>
      url.endsWith('/files/f1/note')
        ? json({ note: { file_id: 'f1', body, updated_at: '' } })
        : undefined,
  ]);
  renderPage(
    <Routes>
      <Route path="/" element={<FileNote libraryId="lib1" fileId="f1" />} />
      <Route path="/people" element={<p>People page</p>} />
    </Routes>,
  );
  return fn;
}

describe('FileNote', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    forgetPeopleIndex();
    vi.restoreAllMocks();
  });

  it('saves at once and shows the caption on Ctrl+Enter', async () => {
    const fn = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a caption' }));
    const box = screen.getByRole('textbox', { name: 'Markdown note' });
    fireEvent.change(box, { target: { value: 'Sunset at **Goa**' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Markdown note preview').innerHTML).toContain(
      '<strong>Goa</strong>',
    );
    await waitFor(() =>
      expect(bodyOf(fn, 'PUT', '/files/f1/note')).toEqual({ body: 'Sunset at **Goa**' }),
    );
  });

  it('links [Name] to the person, and asks before going there', async () => {
    await refreshMLSwitch(true).catch(() => {});
    setup('Lunch with [ritesh]');
    const link = await screen.findByRole('link', { name: 'ritesh' });
    expect(link).toHaveAttribute('href', '/people?person=p1');

    fireEvent.click(link);
    const dialog = await screen.findByTestId('mention-dialog');
    expect(dialog).toHaveTextContent('Go to Ritesh?');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('People page')).toBeInTheDocument();
  });
});
