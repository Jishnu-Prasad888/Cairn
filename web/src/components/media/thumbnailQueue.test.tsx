import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { resetThumbnailQueue, useQueuedImage } from './thumbnailQueue';

function Thumb({ url }: { url: string }) {
  const { src, attach, settle } = useQueuedImage(url);
  return (
    <img
      ref={attach}
      data-testid={url}
      src={src}
      alt=""
      onLoad={() => settle(true)}
      onError={() => settle(false)}
    />
  );
}

const urls = Array.from({ length: 6 }, (_, i) => `/t/${i}`);
const withSrc = () => urls.filter((u) => screen.getByTestId(u).getAttribute('src'));

afterEach(resetThumbnailQueue);

describe('thumbnail queue', () => {
  it('downloads at most four at once and hands slots on', () => {
    render(
      <>
        {urls.map((u) => (
          <Thumb key={u} url={u} />
        ))}
      </>,
    );
    expect(withSrc()).toEqual(urls.slice(0, 4));

    act(() => {
      fireEvent.load(screen.getByTestId('/t/0'));
    });
    expect(withSrc()).toEqual(urls.slice(0, 5));
  });

  it('frees the slot and the place in line of a tile that goes away', () => {
    const { rerender } = render(
      <>
        {urls.map((u) => (
          <Thumb key={u} url={u} />
        ))}
      </>,
    );
    // Tiles 1 (downloading) and 4 (waiting) scroll out of view.
    const kept = urls.filter((u) => u !== '/t/1' && u !== '/t/4');
    rerender(
      <>
        {kept.map((u) => (
          <Thumb key={u} url={u} />
        ))}
      </>,
    );
    expect(kept.filter((u) => screen.getByTestId(u).getAttribute('src'))).toEqual(kept);
  });
});
