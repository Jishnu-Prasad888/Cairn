import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UploadProvider, useUploads } from './UploadProvider';
import { UploadTray } from './UploadTray';

type Handler = (() => void) | null;

/** An XMLHttpRequest whose requests finish when the test says so. */
const requests: FakeXhr[] = [];
class FakeXhr {
  status = 201;
  responseText = '{"file":{}}';
  upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null };
  onload: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  withCredentials = false;
  url = '';
  constructor() {
    requests.push(this);
  }
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send() {}
  abort() {
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  finish(status = 201, body = '{"file":{}}') {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

function Pick() {
  const { enqueue, completed } = useUploads();
  return (
    <>
      <p data-testid="completed">{completed}</p>
      <button
        onClick={() =>
          enqueue(
            'lib1',
            ['a', 'b', 'c'].map((n) => new File(['x'], `${n}.jpg`)),
            'trip',
          )
        }
      >
        add
      </button>
    </>
  );
}

function setup() {
  requests.length = 0;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  render(
    <UploadProvider>
      <Pick />
      <UploadTray />
    </UploadProvider>,
  );
  fireEvent.click(screen.getByText('add'));
}

describe('uploads', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs two at a time, into the chosen folder, and starts the next as one finishes', async () => {
    setup();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(screen.getByText('Uploading 3 files')).toBeInTheDocument();

    act(() => requests[0]!.finish());
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(screen.getByTestId('completed')).toHaveTextContent('1');
  });

  it('reports a failure and retries it', async () => {
    setup();
    await waitFor(() => expect(requests).toHaveLength(2));
    act(() =>
      requests[0]!.finish(
        413,
        JSON.stringify({
          error: { code: 'TOO_LARGE', message: 'That file is too large.', request_id: '1' },
        }),
      ),
    );
    act(() => requests[1]!.finish());
    await waitFor(() => expect(requests).toHaveLength(3));
    act(() => requests[2]!.finish());

    expect(await screen.findByText('1 upload failed')).toBeInTheDocument();
    // The reason sits on the file's own row, and survives collapsing the list.
    expect(screen.getByText('That file is too large.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide upload details' }));
    expect(screen.getByText('a.jpg: That file is too large.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show upload details' }));

    fireEvent.click(screen.getByRole('button', { name: 'Retry a.jpg' }));
    await waitFor(() => expect(requests).toHaveLength(4));
  });

  it('cancels a file in flight', async () => {
    setup();
    await waitFor(() => expect(requests).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel a.jpg' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });

  it('shows overall progress', async () => {
    setup();
    await waitFor(() => expect(requests).toHaveLength(2));
    act(() => requests[0]!.progress(1, 1));
    const bar = screen.getByRole('progressbar', { name: 'Upload progress' });
    await waitFor(() => expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThan(0));
  });

  it('shows each file with its folder and its own progress', async () => {
    setup();
    await waitFor(() => expect(requests).toHaveLength(2));
    act(() => requests[0]!.progress(1, 2));
    const ring = screen.getByRole('progressbar', { name: 'a.jpg progress' });
    await waitFor(() => expect(ring).toHaveAttribute('aria-valuenow', '50'));
    expect(screen.getAllByText('trip')).toHaveLength(3);
    expect(screen.getByRole('progressbar', { name: 'c.jpg progress' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
  });

  it('retries every failed upload at once', async () => {
    setup();
    await waitFor(() => expect(requests).toHaveLength(2));
    act(() => requests[0]!.finish(500));
    act(() => requests[1]!.finish(500));
    await waitFor(() => expect(requests).toHaveLength(3));
    act(() => requests[2]!.finish());
    expect(await screen.findByText('2 uploads failed')).toBeInTheDocument();
    expect(screen.getAllByText('Request failed with status 500.')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }));
    await waitFor(() => expect(requests).toHaveLength(5));
  });
});
