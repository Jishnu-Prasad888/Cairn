import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import HomePage from './HomePage';

function renderPage() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

const health = { status: 'ok', database: 'ok' };
const version = {
  version: 'dev',
  commit: 'abc',
  build_date: '2026-09-22',
  go_version: 'go1.26.4',
  platform: 'linux/amd64',
};

function mockHealthFetch() {
  const fn = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify(health), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/version')) {
      return new Response(JSON.stringify(version), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      '{ "error": { "code": "NOT_FOUND", "message": "missing", "request_id": "1" } }',
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('HomePage', () => {
  it('renders the Cairn brand', () => {
    mockHealthFetch();
    renderPage();
    expect(screen.getByRole('heading', { name: 'Cairn' })).toBeInTheDocument();
  });

  it('shows server and version status after loading', async () => {
    mockHealthFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Version', { selector: 'h2' })).toBeInTheDocument();
    });

    // Version values from the API are rendered.
    const sections = screen.getAllByRole('region');
    void sections;
    expect(screen.getByText('dev')).toBeInTheDocument();
    expect(screen.getByText('abc')).toBeInTheDocument();
  });

  it('shows an error and a retry action when the API is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Could not reach the Cairn server.')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
