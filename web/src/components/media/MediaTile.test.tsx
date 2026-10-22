import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fileFixture } from '../../test/harness';
import { MediaTile } from './MediaTile';
import { resetThumbnailQueue } from './thumbnailQueue';

const file = fileFixture({ id: 'f1', name: 'photo.jpg', media_type: 'photo' });

function renderTile() {
  return render(
    <MediaTile
      libraryId="lib1"
      file={file}
      index={0}
      top={0}
      left={0}
      width={100}
      height={100}
      selected={false}
      selectable={false}
      selecting={false}
      favorite={false}
      tabbable
      onActivate={() => {}}
      onToggleSelect={() => {}}
      onFocusTile={() => {}}
    />,
  );
}

const img = () => screen.getByTestId('media-tile').querySelector('img');

describe('MediaTile thumbnail', () => {
  beforeEach(() => {
    resetThumbnailQueue();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('asks again for a thumbnail that failed, then loads it', () => {
    renderTile();
    const first = img()!.getAttribute('src')!;
    expect(first).toContain('/files/f1/thumbnail');

    fireEvent.error(img()!);
    expect(img()!.getAttribute('src')).toBeNull();
    act(() => vi.advanceTimersByTime(2000));

    const second = img()!.getAttribute('src')!;
    expect(second).not.toBe(first);
    expect(second).toContain('retry=1');
    fireEvent.load(img()!);
    expect(screen.getByTestId('media-tile')).not.toHaveClass('is-placeholder');
  });

  it('shows the broken-image glyph once the retries run out', () => {
    renderTile();
    fireEvent.error(img()!);
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.error(img()!);
    act(() => vi.advanceTimersByTime(8000));
    fireEvent.error(img()!);

    expect(img()).toBeNull();
    expect(screen.getByTestId('media-tile')).toHaveClass('is-placeholder');
  });
});
