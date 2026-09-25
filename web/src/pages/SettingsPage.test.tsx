import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AuthProvider from '../auth/AuthProvider';
import SettingsPage from './SettingsPage';

const admin = {
  id: 'u1',
  username: 'jishnu',
  role: 'admin' as const,
  created_at: '2026-01-01T00:00:00Z',
};

const member = {
  id: 'u2',
  username: 'alice',
  role: 'user' as const,
  created_at: '2026-02-02T00:00:00Z',
};

const originalFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function empty(status: number): Response {
  return new Response(null, { status });
}

function mockFetch(options: { role?: 'admin' | 'user' } = {}) {
  const current = options.role === 'user' ? member : admin;
  const fn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/v1/auth/status')) {
      return json({ bootstrap_required: false, authenticated: true, user: current });
    }
    if (url.endsWith('/api/v1/auth/logout')) {
      return empty(204);
    }
    if (url.endsWith('/api/v1/users') && method === 'POST') {
      return json(
        {
          user: {
            id: 'u3',
            username: 'bob',
            role: 'user',
            created_at: '2026-03-03T00:00:00Z',
          },
        },
        201,
      );
    }
    if (url.endsWith('/api/v1/users')) {
      return json({ users: [admin, member] });
    }
    if (url.includes('/api/v1/users/') && url.endsWith('/sessions/revoke')) {
      return empty(204);
    }
    return json({ error: { code: 'NOT_FOUND', message: 'missing', request_id: '1' } }, 404);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function setup() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('SettingsPage', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('shows the signed-in account and lets it sign out', async () => {
    const fn = mockFetch();
    setup();

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getAllByText('jishnu').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Administrator').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(fn.mock.calls.some(([url]) => String(url).endsWith('/auth/logout'))).toBe(true);
    });
  });

  it('switches between the existing light and dark appearances', async () => {
    mockFetch();
    setup();

    await screen.findByRole('heading', { name: 'Settings' });
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
    });
    expect(localStorage.getItem('cairn.theme')).toBe('dark');

    fireEvent.click(screen.getByRole('radio', { name: 'Match system' }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBeUndefined();
    });
  });

  it('lists accounts for administrators and can revoke sessions', async () => {
    const fn = mockFetch();
    setup();

    const list = await screen.findByTestId('settings-user-list');
    expect(list).toBeInTheDocument();

    const aliceRow = screen.getByText('alice').closest('li');
    expect(aliceRow).not.toBeNull();
    fireEvent.click(
      within(aliceRow as HTMLElement).getByRole('button', { name: 'Revoke sessions' }),
    );

    // The click only opens the confirmation — the request waits for it, so a
    // stray click cannot sign somebody out.
    const dialog = await screen.findByTestId('revoke-sessions-dialog');
    expect(fn.mock.calls.some(([url]) => String(url).includes('/sessions/revoke'))).toBe(false);
    expect(within(dialog as HTMLElement).getByText('alice')).toBeInTheDocument();

    fireEvent.click(within(dialog as HTMLElement).getByRole('button', { name: 'Revoke sessions' }));

    await waitFor(() => {
      expect(
        fn.mock.calls.some(([url]) => String(url).includes('/api/v1/users/u2/sessions/revoke')),
      ).toBe(true);
    });
  });

  it('leaves the account signed in when revoking is cancelled', async () => {
    const fn = mockFetch();
    setup();

    await screen.findByTestId('settings-user-list');
    const aliceRow = screen.getByText('alice').closest('li') as HTMLElement;
    fireEvent.click(within(aliceRow).getByRole('button', { name: 'Revoke sessions' }));

    const dialog = await screen.findByTestId('revoke-sessions-dialog');
    fireEvent.click(within(dialog as HTMLElement).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByTestId('revoke-sessions-dialog')).not.toBeInTheDocument();
    });
    expect(fn.mock.calls.some(([url]) => String(url).includes('/sessions/revoke'))).toBe(false);
  });

  it('creates a new account for administrators', async () => {
    const fn = mockFetch();
    setup();

    await screen.findByTestId('settings-user-list');
    fireEvent.change(screen.getByLabelText('New username'), { target: { value: 'bob' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Created bob.');
    const post = fn.mock.calls.find(
      ([url, init]) => String(url).endsWith('/api/v1/users') && init?.method === 'POST',
    );
    expect(post?.[1]?.body).toBe(
      JSON.stringify({ username: 'bob', password: 's3cret', role: 'user' }),
    );
  });

  it('hides account administration from non-administrators', async () => {
    const fn = mockFetch({ role: 'user' });
    setup();

    expect(await screen.findByRole('heading', { name: 'Access' })).toBeInTheDocument();
    expect(screen.queryByTestId('settings-user-list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument();
    expect(fn.mock.calls.some(([url]) => String(url).endsWith('/api/v1/users'))).toBe(false);
  });
});
