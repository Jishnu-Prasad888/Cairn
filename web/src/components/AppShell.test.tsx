import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { admin, member, mockApi, noContent, originalFetch, renderPage } from '../test/harness';
import Providers from '../test/Providers';
import AppShell from './AppShell';

/** The shell renders an `Outlet`, so the routes have to be declared to render. */
function shell(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Providers>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<p>home content</p>} />
            <Route path="/media" element={<p>media content</p>} />
            <Route path="/browse" element={<p>browse content</p>} />
          </Route>
        </Routes>
      </Providers>
    </MemoryRouter>,
  );
}

describe('AppShell', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('lists every browsing section from the spec, in order', () => {
    mockApi();
    renderPage(<AppShell />);

    const sections = screen.getByRole('navigation', { name: 'Sections' });
    const labels = within(sections)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(labels).toEqual([
      'Home',
      'Media',
      'Memories',
      'Albums',
      'People',
      'Tags',
      'Shared',
      'Favorites',
      'Trash',
      'Settings',
    ]);
  });

  it('groups the maintenance sections separately', () => {
    mockApi();
    renderPage(<AppShell />);

    const upkeep = screen.getByRole('navigation', { name: 'Maintenance' });
    const labels = within(upkeep)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(labels).toEqual([
      'Duplicates',
      'Libraries',
      'Permissions',
      'Machine learning',
      'Backups',
    ]);
  });

  it('does not link the untyped browser, which the search box reaches', () => {
    mockApi();
    renderPage(<AppShell />);

    // A "Browse" link next to Media is one too many.
    expect(screen.queryByRole('link', { name: /Browse/ })).not.toBeInTheDocument();
  });

  it('marks the current section', async () => {
    mockApi();
    shell('/media');

    const current = await screen.findByRole('link', { name: 'Media' });
    expect(current).toHaveClass('active');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveClass('active');
  });

  it('opens and closes the narrow-screen drawer', async () => {
    mockApi();
    shell();

    const toggle = screen.getByTestId('nav-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('nav-backdrop')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // The backdrop is what makes the drawer dismissable on a phone.
    expect(screen.getByTestId('nav-backdrop')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-backdrop'));
    await waitFor(() => {
      expect(screen.getByTestId('nav-toggle')).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('returns focus to the menu button when Escape closes the drawer', async () => {
    mockApi();
    shell();

    const toggle = screen.getByTestId('nav-toggle');
    toggle.focus();
    fireEvent.click(toggle);

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.getByTestId('nav-toggle')).toHaveAttribute('aria-expanded', 'false');
    });
    expect(toggle).toHaveFocus();
  });

  it('sends the search box to the browser', () => {
    mockApi();
    shell();

    fireEvent.change(screen.getByLabelText('Search Cairn'), { target: { value: 'beach' } });
    fireEvent.submit(screen.getByRole('search'));

    expect(screen.getByText('browse content')).toBeInTheDocument();
  });

  it('shows who is signed in and lets them sign out', async () => {
    const fetchMock = mockApi(
      [
        (url, init) =>
          init?.method === 'POST' && url.endsWith('/api/v1/auth/logout') ? noContent() : undefined,
      ],
      { user: member },
    );
    shell();

    // The account is read from the session, so it arrives a tick after render.
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('Member')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sign-out'));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/auth/logout')),
      ).toBe(true);
    });
  });

  it('labels an administrator as such', async () => {
    mockApi([], { user: admin });
    shell();

    expect(await screen.findByText('Administrator')).toBeInTheDocument();
  });
});
