/**
 * MemoryPrintSheet — the memory as a plain, paper-ready document.
 *
 * Used only for Export → PDF…: it renders outside the app shell (a portal to
 * <body>) and is hidden on screen; the `@media print` rules reveal it and hide
 * everything else. Unlike the reading view there are no layouts, crops or
 * aspect-ratio boxes here — photos flow in order at their natural shape, so
 * the printed pages stay predictable whatever the memory's sections look like.
 */

import { useMemo } from 'react';
import { createPortal } from 'react-dom';

import { renderMarkdown } from '../lib/markdown';
import { formatMemoryDate } from './format';
import type { MemoryMeta } from './useMemoryDocument';
import type { MemoryBlock, MemoryImage } from './types';

/** The best uncropped source for paper: an edited copy if one exists. */
function printImageSrc(image: MemoryImage): string {
  return image.derived?.url ?? image.media.original_url ?? image.media.thumbnail_url ?? '';
}

function PrintText({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMarkdown(markdown).html, [markdown]);
  if (!markdown.trim()) return null;
  return <div className="print-text md-render" dangerouslySetInnerHTML={{ __html: html }} />;
}

interface Props {
  meta: MemoryMeta;
  blocks: MemoryBlock[];
}

export function MemoryPrintSheet({ meta, blocks }: Props) {
  const date = formatMemoryDate(meta.memory_date);
  return createPortal(
    <article className="print-sheet" data-testid="memory-print-sheet" aria-hidden="true">
      <header className="print-head">
        <h1 className="print-title">{meta.title || 'Untitled memory'}</h1>
        {(date || meta.location) && (
          <p className="print-dateline">
            {date && <time dateTime={meta.memory_date}>{date}</time>}
            {date && meta.location && <span aria-hidden="true"> · </span>}
            {meta.location && <span>{meta.location}</span>}
          </p>
        )}
        {meta.description && <p className="print-description">{meta.description}</p>}
      </header>

      {blocks.map((block) => {
        if (block.type === 'text') {
          return <PrintText key={block.id} markdown={block.markdown} />;
        }
        const shots = block.images.filter((image) => image.media.available);
        if (shots.length === 0) return null;
        return (
          <section
            key={block.id}
            className={shots.length === 1 ? 'print-images is-single' : 'print-images'}
          >
            {shots.map((image) => (
              <figure className="print-figure" key={image.id}>
                <img src={printImageSrc(image)} alt={image.caption || image.media.name || ''} />
                {image.caption && <figcaption>{image.caption}</figcaption>}
              </figure>
            ))}
          </section>
        );
      })}

      {meta.tags.length > 0 && (
        <footer className="print-footer">
          <ul className="print-tags" aria-label="Tags">
            {meta.tags.map((tag) => (
              <li key={tag}>#{tag}</li>
            ))}
          </ul>
        </footer>
      )}
    </article>,
    document.body,
  );
}
