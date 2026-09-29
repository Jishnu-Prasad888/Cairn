import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  apiError,
  bodyOf,
  called,
  fileFixture,
  json,
  libraryFixture,
  member,
  mockApi,
  noContent,
  originalFetch,
  renderPage,
} from '../test/harness';
import type { RouteHandler } from '../test/harness';
import { FOCUSABLE } from '../lib/focusTrap';
import MediaPage from './MediaPage';
import type { MediaPageConfig } from './MediaPage';

const CONFIG: MediaPageConfig = {
  title: 'Files',
  showFolders: true,
  subtitle: 'Everything the indexer found, whatever its type.',
  emptyTitle: 'Nothing here yet',
  emptyBody: 'This folder is empty. Upload a file to get started.',
};

const folders = {
  folders: [{ id: 'dir1', rel_path: '2024', name: '2024', file_count: 2 }],
};

const photo = fileFixture();
const video = fileFixture({
  id: 'f2',
  rel_path: 'clip.mp4',
  name: 'clip.mp4',
  size_bytes: 4194304,
  media_type: 'video',
  mime_type: 'video/mp4',
  content_hash: 'def',
});

const pageOne = { files: [photo, video], next_cursor: '', total: 2 };
const metadata = {
  metadata: {
    file_id: 'f1',
    media_type: 'photo',
    mime_type: 'image/png',
    width: 4032,
    height: 3024,
    camera_make: 'Apple',
    camera_model: 'iPhone 15',
    taken_at: '2026-06-01T12:00:00Z',
    latitude: 51.5074,
    longitude: -0.1278,
    has_thumbnail: true,
  },
};

const note = { note: { file_id: 'f1', body: '', updated_at: '' } };

/**
 * The endpoints the browser and the viewer touch, in the order they have to be
 * matched: `/files/f1/note` and `/files/f1/metadata` also contain `/files`, so
 * the longer paths come first.
 */
function apiRules(overrides: RouteHandler[] = []): RouteHandler[] {
  return [
    ...overrides,
    (url, init) =>
      url.endsWith('/api/v1/libraries/lib1/files/f1/note') && init?.method === 'PUT'
        ? json({ note: { file_id: 'f1', body: '', updated_at: '' } })
        : undefined,
    (url) =>
      url.includes('/api/v1/libraries/lib1/files/f1/note') ||
      url.includes('/api/v1/libraries/lib1/files/f2/note')
        ? json(note)
        : undefined,
    (url) =>
      url.includes('/api/v1/libraries/lib1/files/f1/metadata') ? json(metadata) : undefined,
    (url) =>
      url.includes('/api/v1/libraries/lib1/files/f1/favorite') ||
      url.includes('/api/v1/libraries/lib1/files/f2/favorite')
        ? noContent()
        : undefined,
    (url) => (url.includes('/api/v1/libraries/lib1/favorites') ? json({ files: [] }) : undefined),
    (url) => (url.includes('/search?q=') ? json({ files: [photo] }) : undefined),
    (url) => (url.includes('/api/v1/libraries/lib1/folders') ? json(folders) : undefined),
    (url) => (url.includes('/api/v1/libraries/lib1/files?') ? json(pageOne) : undefined),
  ];
}

function setup(overrides: RouteHandler[] = []) {
  const fn = mockApi(apiRules(overrides));
  renderPage(<MediaPage config={CONFIG} />);
  return fn;
}

describe('MediaPage', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders the heading, the folders, and a file grid', async () => {
    setup();

    expect(await screen.findByRole('heading', { name: 'Files' })).toBeInTheDocument();
    expect(await screen.findByTestId('file-grid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2024/ })).toBeInTheDocument();
    expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
  });

  it('preselects the type filter from ?type= and sends it to the API', async () => {
    const fetchMock = mockApi(apiRules());
    renderPage(<MediaPage config={CONFIG} />, { route: '/media?type=video' });

    await screen.findByTestId('file-grid');
    expect(screen.getByTestId('type-filter-select')).toHaveValue('video');
    expect(called(fetchMock, 'GET', 'type=video')).toBe(true);
  });

  it('ignores an unknown ?type= value', async () => {
    mockApi(apiRules());
    renderPage(<MediaPage config={CONFIG} />, { route: '/media?type=bogus' });

    await screen.findByTestId('file-grid');
    expect(screen.getByTestId('type-filter-select')).toHaveValue('');
  });

  it('shows how much of the result set is on screen', async () => {
    setup();

    await screen.findByTestId('file-grid');
    expect(screen.getByTestId('result-count')).toHaveTextContent('Showing 2 of 2');
    // No cursor means no more pages, so no "Load more".
    expect(screen.queryByTestId('load-more')).not.toBeInTheDocument();
  });

  it('switches to the list view', async () => {
    setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByRole('button', { name: 'List' }));

    const list = await screen.findByTestId('file-list');
    expect(within(list).getByRole('button', { name: /IMG_0001.png/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('steps into a folder and back to the root', async () => {
    const fetchMock = setup([(url) => (url.includes('folder=2024') ? json(pageOne) : undefined)]);

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByRole('button', { name: /2024/ }));

    await waitFor(() => {
      expect(called(fetchMock, 'GET', 'folder=2024')).toBe(true);
    });
    // Breadcrumbs appear once there is somewhere to go back to.
    fireEvent.click(await screen.findByRole('button', { name: 'Library root' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Library root' })).toBeInTheDocument();
    });
  });

  it('sends the chosen sort to the API', async () => {
    const fetchMock = setup();

    await screen.findByTestId('file-grid');
    fireEvent.change(screen.getByTestId('sort-select'), { target: { value: 'name:asc' } });

    await waitFor(() => {
      expect(called(fetchMock, 'GET', 'sort=name')).toBe(true);
    });
    await waitFor(() => {
      expect(called(fetchMock, 'GET', 'order=asc')).toBe(true);
    });
  });

  it('applies and clears the date and size filters', async () => {
    const fetchMock = setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByTestId('toggle-filters'));
    const filters = await screen.findByTestId('media-filters');

    fireEvent.change(within(filters).getByLabelText('Min size (MB)'), {
      target: { value: '2' },
    });
    await waitFor(() => {
      expect(called(fetchMock, 'GET', 'min_size=2')).toBe(true);
    });

    fireEvent.change(within(filters).getByLabelText('Modified after'), {
      target: { value: '2026-01-01' },
    });
    await waitFor(() => {
      expect(called(fetchMock, 'GET', 'from=2026-01-01')).toBe(true);
    });

    // Clearing puts the filters back to their defaults, and the listing reloads
    // without them.
    fireEvent.click(within(filters).getByRole('button', { name: 'Clear filters' }));
    expect(within(filters).getByLabelText('Min size (MB)')).toHaveValue(null);
    await waitFor(() => {
      expect(called(fetchMock, 'GET', 'min_size=2')).toBe(true);
      expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
    });
  });

  it('appends the next page of results on "Load more"', async () => {
    const second = fileFixture({ id: 'f3', rel_path: 'beach.jpg', name: 'beach.jpg' });
    const fetchMock = setup([
      (url) =>
        url.includes('cursor=cur2')
          ? json({ files: [second], next_cursor: '', total: 3 })
          : undefined,
      (url) =>
        url.includes('/files?') ? json({ ...pageOne, next_cursor: 'cur2', total: 3 }) : undefined,
    ]);

    await screen.findByTestId('file-grid');
    expect(screen.getByTestId('result-count')).toHaveTextContent('Showing 2 of 3');

    fireEvent.click(screen.getByTestId('load-more'));

    expect(await screen.findByText('beach.jpg')).toBeInTheDocument();
    expect(screen.getByTestId('result-count')).toHaveTextContent('Showing 3 of 3');
    await waitFor(() => {
      expect(called(fetchMock, 'GET', 'cursor=cur2')).toBe(true);
    });
    expect(screen.queryByTestId('load-more')).not.toBeInTheDocument();
  });

  it('searches the whole library and reports when nothing matches', async () => {
    setup([(url) => (url.includes('/search?q=zzz') ? json({ files: [] }) : undefined)]);

    await screen.findByTestId('file-grid');
    const search = screen.getByLabelText('Search this library');
    fireEvent.change(search, { target: { value: 'sunset' } });

    await waitFor(() => {
      expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
    });
    // A search means "anywhere in this library", so the folders step aside.
    expect(screen.queryByRole('button', { name: /2024/ })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(await screen.findByTestId('search-empty')).toBeInTheDocument();
  });

  it('shows the empty state for a folder with nothing in it', async () => {
    setup([
      (url) => (url.includes('/folders') ? json({ folders: [] }) : undefined),
      (url) =>
        url.includes('/files?') ? json({ files: [], next_cursor: '', total: 0 }) : undefined,
    ]);

    expect(await screen.findByTestId('browser-empty')).toBeInTheDocument();
  });

  it('uploads a file into the current folder', async () => {
    const fetchMock = setup([
      (url, init) =>
        url.includes('/api/v1/libraries/lib1/files/upload')
          ? json({ file: photo }, init?.method === 'POST' ? 201 : 200)
          : undefined,
    ]);

    const input = await screen.findByTestId('upload-input');
    const file = new File(['bytes'], 'beach.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    await waitFor(() => {
      expect(called(fetchMock, 'POST', '/api/v1/libraries/lib1/files/upload')).toBe(true);
    });
    const upload = fetchMock.mock.calls.find(([input]) => String(input).includes('/files/upload'));
    expect(upload?.[1]?.body).toBeInstanceOf(FormData);
    expect((upload?.[1]?.body as FormData).get('path')).toBe('beach.jpg');
    // The listing reloads afterwards.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).includes('/folders')).length,
      ).toBeGreaterThan(1);
    });
  });

  it('trashes a selection after confirming the dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const fetchMock = setup([
      (url, init) =>
        init?.method === 'DELETE' && url.includes('/api/v1/libraries/lib1/files/')
          ? noContent()
          : undefined,
    ]);

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByRole('button', { name: 'Select IMG_0001.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select clip.mp4' }));

    const bar = await screen.findByTestId('selection-bar');
    expect(screen.getByTestId('selection-count')).toHaveTextContent('2 selected');
    expect(within(bar).getByRole('button', { name: 'Move to trash' })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('selection-trash'));
    const dialog = await screen.findByTestId('trash-many-dialog');
    expect(within(dialog).getByRole('heading', { name: /Move 2 items to trash/ })).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to trash' }));

    await waitFor(() => {
      expect(called(fetchMock, 'DELETE', '/api/v1/libraries/lib1/files/f1')).toBe(true);
    });
    expect(called(fetchMock, 'DELETE', '/api/v1/libraries/lib1/files/f2')).toBe(true);
    // The soft delete acts on the path, not the id.
    expect(bodyOf(fetchMock, 'DELETE', '/api/v1/libraries/lib1/files/f1')).toEqual({
      path: 'IMG_0001.png',
    });
    await waitFor(() => {
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('keeps the selection when the trash dialog is cancelled', async () => {
    const fetchMock = setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByRole('button', { name: 'Select IMG_0001.png' }));
    fireEvent.click(await screen.findByTestId('selection-trash'));

    const dialog = await screen.findByTestId('trash-many-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByTestId('trash-many-dialog')).not.toBeInTheDocument();
    });
    expect(called(fetchMock, 'DELETE', '/api/v1/libraries/lib1/files/f1')).toBe(false);
    expect(screen.getByTestId('selection-count')).toHaveTextContent('1 selected');
  });

  it('clears the selection on Escape', async () => {
    setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByRole('button', { name: 'Select IMG_0001.png' }));
    await screen.findByTestId('selection-bar');

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    });
  });

  it('opens a photo viewer with a preview and a download link, and closes it', async () => {
    setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));

    const viewer = await screen.findByTestId('viewer');
    const dialog = within(viewer).getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('img')).toHaveAttribute(
      'src',
      '/api/v1/libraries/lib1/files/f1/thumbnail',
    );
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/v1/libraries/lib1/files/f1/download',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close viewer' }));
    await waitFor(() => {
      expect(screen.queryByTestId('viewer')).not.toBeInTheDocument();
    });
  });

  it('opens a video viewer with inline playback', async () => {
    setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('clip.mp4'));

    const viewer = await screen.findByTestId('viewer');
    const video = viewer.querySelector('video');
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('src', '/api/v1/libraries/lib1/files/f2/download');
  });

  it('steps through the siblings and reports its position', async () => {
    setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));

    const viewer = await screen.findByTestId('viewer');
    const dialog = within(viewer).getByRole('dialog');
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Previous item' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Next item' }));
    await waitFor(() => {
      expect(screen.getByText('2 of 2')).toBeInTheDocument();
    });
    expect(within(dialog).getByRole('button', { name: 'Previous item' })).toBeInTheDocument();

    // The keyboard does the same thing.
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(screen.getByText('1 of 2')).toBeInTheDocument();
    });
  });

  it('zooms in, resets, and zooms out again', async () => {
    setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    const viewer = await screen.findByTestId('viewer');
    const dialog = within(viewer).getByRole('dialog');

    const stage = within(viewer).getByTestId('viewer-stage');
    expect(stage).toHaveAttribute('data-zoomed', 'false');
    expect(within(dialog).getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('100%');
    // Nothing to zoom out of at 100%, and nothing to zoom out *back* into.
    expect(within(dialog).getByRole('button', { name: 'Zoom out' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => {
      expect(stage).toHaveAttribute('data-zoomed', 'true');
    });
    expect(within(dialog).getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('150%');

    // The keyboard resets to fit, and the button does the same.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    fireEvent.keyDown(window, { key: '0' });
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('100%');
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    });
    expect(stage).toHaveAttribute('data-zoomed', 'false');
  });

  it('grows the media itself when zoomed, so the stage can scroll to its edges', async () => {
    setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    const viewer = await screen.findByTestId('viewer');
    const dialog = within(viewer).getByRole('dialog');
    const image = within(dialog).getByAltText('IMG_0001.png') as HTMLElement;

    // Unzoomed the image fits the stage, so it takes no explicit width.
    expect(image.style.width).toBe('');

    // Zooming must change the layout box, not just paint a `transform` over it:
    // a transform does not enlarge the scrollable area, so the corners of a
    // scaled image would be drawn but unreachable.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => {
      expect(within(viewer).getByTestId('viewer-stage')).toHaveAttribute('data-zoomed', 'true');
    });
    expect(image.style.width).toBe('150%');
    expect(image.style.transform).toBe('');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => {
      expect(image.style.width).toBe('200%');
    });
  });

  it('keeps Tab inside the viewer while it is open', async () => {
    setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    const viewer = await screen.findByTestId('viewer');
    const dialog = within(viewer).getByRole('dialog');

    // `aria-modal` promises the page behind is unreachable, so focus has to
    // wrap at both ends of the dialog rather than escaping to the grid.
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    expect(focusable.length).toBeGreaterThan(1);
    // The first stop is the close button, and the last is the last control in
    // the panel — whatever the panel happens to end with.
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    expect(first).toHaveAccessibleName('Close viewer');

    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('hides and restores the details panel', async () => {
    setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    await screen.findByTestId('viewer-details-panel');

    fireEvent.click(screen.getByTestId('toggle-panel'));
    await waitFor(() => {
      expect(screen.queryByTestId('viewer-details-panel')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('toggle-panel'));
    expect(await screen.findByTestId('viewer-details-panel')).toBeInTheDocument();
  });

  it('shows extracted metadata and toggles the favorite', async () => {
    const fetchMock = setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    const viewer = await screen.findByTestId('viewer');
    const dialog = within(viewer).getByRole('dialog');

    await within(dialog).findByTestId('viewer-details');
    expect(within(dialog).getByText('4032 × 3024px')).toBeInTheDocument();
    expect(within(dialog).getByText('Apple iPhone 15')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '51.50740, -0.12780' })).toHaveAttribute(
      'href',
      expect.stringContaining('openstreetmap.org'),
    );

    // Nothing is favorited yet, so the control offers to add one.
    const favorite = await within(dialog).findByRole('button', { name: '☆ Favorite' });
    expect(favorite).toBeEnabled();

    fireEvent.click(favorite);
    await within(dialog).findByRole('button', { name: '★ Favorite' });
    expect(called(fetchMock, 'POST', '/api/v1/libraries/lib1/files/f1/favorite')).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: '★ Favorite' }));
    await within(dialog).findByRole('button', { name: '☆ Favorite' });
    expect(called(fetchMock, 'DELETE', '/api/v1/libraries/lib1/files/f1/favorite')).toBe(true);
  });

  it('renames a file from the viewer dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const fetchMock = setup([
      (url, init) =>
        init?.method === 'POST' && url.includes('/api/v1/libraries/lib1/files/f1/rename')
          ? json({ file: photo })
          : undefined,
    ]);

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    const viewer = await screen.findByTestId('viewer');
    fireEvent.click(
      within(within(viewer).getByRole('dialog')).getByRole('button', { name: 'Rename' }),
    );

    const dialog = await screen.findByTestId('rename-dialog');
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'sunset.png' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(called(fetchMock, 'POST', '/api/v1/libraries/lib1/files/f1/rename')).toBe(true);
    });
    expect(bodyOf(fetchMock, 'POST', '/api/v1/libraries/lib1/files/f1/rename')).toEqual({
      path: 'IMG_0001.png',
      new_name: 'sunset.png',
    });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('moves a file into a folder picked from the dropdown', async () => {
    const fetchMock = setup([
      (url, init) =>
        init?.method === 'POST' && url.includes('/api/v1/libraries/lib1/files/f1/move')
          ? json({ file: photo })
          : undefined,
      // The picker walks the tree a level at a time: the root, then the
      // children of the one folder it found.
      (url) =>
        url.includes('/api/v1/libraries/lib1/folders?parent=2024')
          ? json({ folders: [] })
          : undefined,
    ]);

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    const viewer = await screen.findByTestId('viewer');
    fireEvent.click(
      within(within(viewer).getByRole('dialog')).getByRole('button', { name: 'Move' }),
    );

    const dialog = await screen.findByTestId('move-dialog');
    const menu = await within(dialog).findByLabelText('Pick an existing folder');
    // The indexed folder is offered, so nobody has to remember its path.
    expect(menu).toHaveValue('');

    fireEvent.change(menu, { target: { value: '2024' } });
    // The menu and the text field are one value, so picking from the menu has
    // to update the field the request is built from.
    const field = within(dialog).getByLabelText('Destination folder');
    expect(field).toHaveValue('2024');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(called(fetchMock, 'POST', '/api/v1/libraries/lib1/files/f1/move')).toBe(true);
    });
    expect(bodyOf(fetchMock, 'POST', '/api/v1/libraries/lib1/files/f1/move')).toMatchObject({
      new_path: '2024/IMG_0001.png',
    });
  });

  it('still accepts a destination folder that the index has never seen', async () => {
    // The browser asks for folders once on load to draw its own folder grid;
    // the picker asks again when the move dialog opens. Fail everything after
    // that first call, which is exactly the library that cannot list folders.
    let folderCalls = 0;
    const fetchMock = setup([
      (url, init) =>
        init?.method === 'POST' && url.includes('/api/v1/libraries/lib1/files/f1/move')
          ? json({ file: photo })
          : undefined,
      (url) =>
        url.includes('/api/v1/libraries/lib1/folders')
          ? folderCalls++ === 0
            ? json(folders)
            : apiError(500, 'INTERNAL', 'folder listing unavailable')
          : undefined,
    ]);

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    const viewer = await screen.findByTestId('viewer');
    fireEvent.click(
      within(within(viewer).getByRole('dialog')).getByRole('button', { name: 'Move' }),
    );

    const dialog = await screen.findByTestId('move-dialog');
    // The menu is hidden rather than shown offering only the root, and the
    // field is still there to type into.
    await waitFor(() => {
      expect(within(dialog).queryByLabelText('Pick an existing folder')).not.toBeInTheDocument();
    });
    expect(within(dialog).getByText(/type the path/)).toBeInTheDocument();

    const field = within(dialog).getByLabelText('Destination folder');
    fireEvent.change(field, { target: { value: 'brand/new/folder' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(called(fetchMock, 'POST', '/api/v1/libraries/lib1/files/f1/move')).toBe(true);
    });
    expect(bodyOf(fetchMock, 'POST', '/api/v1/libraries/lib1/files/f1/move')).toMatchObject({
      new_path: 'brand/new/folder/IMG_0001.png',
    });
  });

  it('trashes a file from the viewer and closes the viewer', async () => {
    const fetchMock = setup([
      (url, init) =>
        init?.method === 'DELETE' && url.includes('/api/v1/libraries/lib1/files/f1')
          ? noContent()
          : undefined,
    ]);

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    fireEvent.click(await screen.findByTestId('viewer-trash'));

    const dialog = await screen.findByTestId('trash-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to trash' }));

    await waitFor(() => {
      expect(called(fetchMock, 'DELETE', '/api/v1/libraries/lib1/files/f1')).toBe(true);
    });
    expect(bodyOf(fetchMock, 'DELETE', '/api/v1/libraries/lib1/files/f1')).toEqual({
      path: 'IMG_0001.png',
    });
    await waitFor(() => {
      expect(screen.queryByTestId('viewer')).not.toBeInTheDocument();
    });
  });

  it('autosaves a Markdown note and previews it', async () => {
    const fetchMock = setup();

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    const viewer = await screen.findByTestId('viewer');
    const noteSection = await within(viewer).findByTestId('viewer-note');

    const textarea = within(noteSection).getByLabelText('Markdown note');
    fireEvent.change(textarea, { target: { value: '# Beach day\n\nSunset over the **dunes**.' } });
    fireEvent.click(within(noteSection).getByRole('button', { name: 'Preview' }));

    expect(within(noteSection).getByRole('heading', { name: 'Beach day' })).toBeInTheDocument();
    expect(within(noteSection).getByText('dunes')).toBeInTheDocument();

    await waitFor(
      () => {
        expect(called(fetchMock, 'PUT', '/api/v1/libraries/lib1/files/f1/note')).toBe(true);
      },
      { timeout: 3000 },
    );
    expect(bodyOf(fetchMock, 'PUT', '/api/v1/libraries/lib1/files/f1/note')).toMatchObject({
      body: '# Beach day\n\nSunset over the **dunes**.',
    });
  });

  it('attaches an existing tag to a file from the tags panel', async () => {
    const fetchMock = setup([
      (url) =>
        url.includes('/api/v1/libraries/lib1/tags')
          ? json({ tags: [{ id: 't1', name: 'beach' }] })
          : undefined,
      (url) =>
        url.includes('/api/v1/libraries/lib1/files/f1/tags') ? json({ tags: [] }) : undefined,
      (url, init) =>
        init?.method === 'POST' && url.includes('/api/v1/libraries/lib1/files/f1/tags')
          ? noContent(201)
          : undefined,
    ]);

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    fireEvent.click(await screen.findByTestId('viewer-tab-tags'));

    const panel = await screen.findByTestId('viewer-tags');
    expect(within(panel).getByText('No tags on this file.')).toBeInTheDocument();

    fireEvent.change(within(panel).getByLabelText('Add a tag'), { target: { value: 'beach' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(called(fetchMock, 'POST', '/api/v1/libraries/lib1/files/f1/tags')).toBe(true);
    });
    expect(bodyOf(fetchMock, 'POST', '/api/v1/libraries/lib1/files/f1/tags')).toEqual({
      tag_id: 't1',
    });
  });

  it('lists the memories that mention a file', async () => {
    setup([
      (url) =>
        url.includes('/api/v1/libraries/lib1/memories?')
          ? json({
              memories: [
                { id: 'm1', title: 'Beach day', body: '', memory_date: '2026-06-01' },
                { id: 'm2', title: 'Quiet Sunday', body: '', memory_date: '' },
              ],
            })
          : undefined,
      (url) =>
        url.includes('/api/v1/libraries/lib1/memories/m1/refs')
          ? json({ refs: [{ type: 'media', id: 'f1' }] })
          : undefined,
      (url) =>
        url.includes('/api/v1/libraries/lib1/memories/m2/refs') ? json({ refs: [] }) : undefined,
    ]);

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    fireEvent.click(await screen.findByTestId('viewer-tab-memories'));

    const linked = await screen.findByTestId('viewer-memories');
    expect(within(linked).getByText('Beach day')).toBeInTheDocument();
    expect(within(linked).queryByText('Quiet Sunday')).not.toBeInTheDocument();
  });

  it('says so plainly when similarity search is unavailable', async () => {
    setup([
      (url) =>
        url.includes('/api/v1/libraries/lib1/files/f1/similar')
          ? apiError(503, 'ML_DISABLED', 'ML is disabled')
          : undefined,
    ]);

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    fireEvent.click(await screen.findByTestId('viewer-tab-similar'));

    expect(await screen.findByTestId('viewer-similar-unavailable')).toBeInTheDocument();
  });

  it('creates a read-only share link for a file', async () => {
    const fetchMock = setup([
      (url, init) =>
        init?.method === 'POST' && url.endsWith('/api/v1/libraries/lib1/shares')
          ? json(
              {
                share: { id: 'sh1', key: 'file:lib1/IMG_0001.png', caps: ['read'] },
                token: 'tok123',
              },
              201,
            )
          : undefined,
    ]);

    await screen.findByTestId('file-grid');
    fireEvent.click(screen.getByText('IMG_0001.png'));
    fireEvent.click(await screen.findByTestId('viewer-tab-share'));

    const panel = await screen.findByTestId('viewer-share');
    expect(panel).toHaveTextContent('file:lib1/IMG_0001.png');

    fireEvent.click(screen.getByTestId('viewer-create-share'));

    await waitFor(() => {
      expect(called(fetchMock, 'POST', '/api/v1/libraries/lib1/shares')).toBe(true);
    });
    const link = (await screen.findByLabelText('Share link')) as HTMLInputElement;
    expect(link.value).toMatch(/\/s\/tok123$/);
    expect(bodyOf(fetchMock, 'POST', '/api/v1/libraries/lib1/shares')).toMatchObject({
      key: 'file:lib1/IMG_0001.png',
      caps: ['read'],
    });
  });

  it('explains an offline library instead of showing an empty page', async () => {
    mockApi(apiRules(), { libraries: [libraryFixture({ status: 'offline' })] });
    renderPage(<MediaPage config={CONFIG} />);

    expect(await screen.findByTestId('library-offline')).toBeInTheDocument();
    // Uploading to a disk that is not there is not offered.
    expect(screen.queryByTestId('upload-input')).not.toBeInTheDocument();
  });

  it('tells a member with no libraries to ask an administrator', async () => {
    mockApi([], { user: member, libraries: [] });
    renderPage(<MediaPage config={CONFIG} />);

    expect(await screen.findByTestId('no-libraries')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add a library' })).not.toBeInTheDocument();
  });

  it('reports a listing failure and retries', async () => {
    let attempts = 0;
    const fetchMock = mockApi([
      (url) => (url.includes('/api/v1/libraries/lib1/folders') ? json(folders) : undefined),
      (url) => {
        if (!url.includes('/api/v1/libraries/lib1/files?')) return undefined;
        attempts += 1;
        return attempts === 1
          ? apiError(500, 'INTERNAL', 'The listing could not be loaded.')
          : json(pageOne);
      },
    ]);
    renderPage(<MediaPage config={CONFIG} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The listing could not be loaded.');

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('file-grid')).toBeInTheDocument();
    expect(called(fetchMock, 'GET', '/api/v1/libraries/lib1/files?')).toBe(true);
  });
});
