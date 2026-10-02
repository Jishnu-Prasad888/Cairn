/**
 * ImageBlockView — an image section as it appears in the memory.
 *
 * Shows the section in its layout, or — when the section has a slideshow —
 * as a slideshow, with a small "Layout view / Slideshow" switch so a reader
 * can choose either presentation.
 */

import { type MouseEvent, useState } from 'react';

import { LayoutRenderer } from './layouts';
import { Slideshow } from './Slideshow';
import type { ImageBlock, MemoryImage } from './types';

interface Props {
  block: ImageBlock;
  defaultInterval: number;
  reading: boolean;
  onImageContextMenu?: (image: MemoryImage, event: MouseEvent<HTMLElement>) => void;
  onImageActivate?: (image: MemoryImage) => void;
}

export function ImageBlockView({
  block,
  defaultInterval,
  reading,
  onImageContextMenu,
  onImageActivate,
}: Props) {
  const [view, setView] = useState<'slideshow' | 'layout'>('slideshow');
  const slideshow = block.slideshow.enabled && block.images.length > 1;
  const showSlides = slideshow && view === 'slideshow';
  const interval = block.slideshow.interval_seconds ?? defaultInterval;

  return (
    <div className={`image-block image-block-${block.layout}`}>
      {slideshow && (
        <div className="image-block-views segmented" role="group" aria-label="Show this section as">
          <button
            type="button"
            className={!showSlides ? 'segment active' : 'segment'}
            aria-pressed={!showSlides}
            onClick={() => setView('layout')}
          >
            Layout view
          </button>
          <button
            type="button"
            className={showSlides ? 'segment active' : 'segment'}
            aria-pressed={showSlides}
            onClick={() => setView('slideshow')}
          >
            Slideshow
          </button>
        </div>
      )}
      {showSlides ? (
        <Slideshow
          images={block.images}
          interval={interval}
          label={`Slideshow of ${block.images.length} photos`}
          {...(onImageContextMenu && { onImageContextMenu })}
        />
      ) : (
        <LayoutRenderer
          layout={block.layout}
          images={block.images}
          reading={reading}
          {...(onImageContextMenu && { onImageContextMenu })}
          {...(onImageActivate && { onImageActivate })}
        />
      )}
    </div>
  );
}
