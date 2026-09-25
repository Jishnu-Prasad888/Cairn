/**
 * A small, safe Markdown renderer used for Cairn memory previews.
 *
 * The renderer intentionally supports only a practical subset of Markdown and
 * ALWAYS HTML-escapes the source first, so untrusted content (including
 * [[type:id]] references typed by users) can never inject markup. Supported
 * syntax:
 *
 *   - ATX headings (# to ######)
 *   - paragraphs
 *   - unordered (`- `) and ordered (`1. `) lists
 *   - blockquotes (`> `)
 *   - fenced code blocks (```)
 *   - inline code (`code`)
 *   - bold / italic
 *   - links [text](url) and autolinks <https://...>
 *   - internal references [[type:ID|label]]
 *   - thematic breaks (---)
 *
 * It is intentionally NOT a full CommonMark implementation. Long-form memory
 * bodies render as readable prose; anything unsupported is shown as escaped
 * text rather than being dropped.
 */

export type RefType = 'media' | 'memory' | 'album' | 'person' | 'tag';

/** A `@type:id` reference found in a Markdown body. */
interface RefLink {
  type: RefType;
  id: string;
  label: string;
}

const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESCAPE[ch] ?? ch);
}

const REF_RE = /\[\[([a-z]+):([^|\]\n]+)(?:\|([^\]\n]*))?\]\]/g;

/**
 * Extracts the internal references from a memory body. Used by the picker and
 * to render [[type:id]] affordances in the preview.
 */
export function extractRefs(body: string, limit = 200): RefLink[] {
  const refs: RefLink[] = [];
  const seen = new Set<string>();
  const source = body.replace(/```[\s\S]*?```/g, '');
  for (const match of source.matchAll(/\[\[([a-z]+):([^|\]\n]+)(?:\|([^\]\n]*))?\]\]/g)) {
    const type = match[1] as RefType;
    const id = match[2];
    const label = match[3] ?? '';
    if (!['media', 'memory', 'album', 'person', 'tag'].includes(type) || !id) {
      continue;
    }
    const key = `${type}:${id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push({ type, id, label });
    if (refs.length >= limit) {
      break;
    }
  }
  return refs;
}

const SAFE_URL_RE = /^(?:https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)[^\s]*$/i;

function safeUrl(url: string): string {
  return SAFE_URL_RE.test(url) ? url : '#';
}

/**
 * Applies inline formatting to already-escaped text, keeping bold/italic/code
 * and turning markdown links and [[type:id]] references into anchors.
 */
function renderInline(input: string, refs: RefLink[]): string {
  let out = input;

  out = out.replace(REF_RE, (_full, type: string, id: string, label: string) => {
    if (!['media', 'memory', 'album', 'person', 'tag'].includes(type) || !id) {
      return _full;
    }
    const ref = { type: type as RefType, id, label: label ?? '' };
    refs.push(ref);
    const text = ref.label || `${type} ${id}`;
    return `<a class="md-ref md-ref-${type}" data-ref-type="${type}" data-ref-id="${escapeHtml(id)}">${text}</a>`;
  });

  // `code`
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // **bold**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // _italic_ and *italic*
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/_(?!_)([^_\n]+)_(?!_)/g, '<em>$1</em>');
  // [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_full, text: string, url: string) => {
    return `<a href="${escapeHtml(safeUrl(url))}">${escapeHtml(text)}</a>`;
  });
  return out;
}

/**
 * Renders Markdown body text to an HTML string that is safe to inject with
 * dangerouslySetInnerHTML. Also returns the references encountered.
 */
export function renderMarkdown(body: string): { html: string; refs: RefLink[] } {
  const refs: RefLink[] = [];
  const paragraphs: string[] = [];
  const rawBlocks = body.split(/\r?\n/);

  let i = 0;
  while (i < rawBlocks.length) {
    const line = rawBlocks[i]!;

    // Blank lines separate blocks; skip them.
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Fenced code block.
    if (/^```/.test(line)) {
      const buffer = [line.replace(/^`+/, '')];
      i += 1;
      while (i < rawBlocks.length && !/^```/.test(rawBlocks[i]!)) {
        buffer.push(escapeHtml(rawBlocks[i]!));
        i += 1;
      }
      if (i < rawBlocks.length) {
        i += 1; // consume closing fence
      }
      paragraphs.push(`<pre><code>${buffer.join('\n')}</code></pre>`);
      continue;
    }

    // Thematic break.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      paragraphs.push('<hr>');
      i += 1;
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length, 6);
      const html = renderInline(escapeHtml(heading[2]!), refs);
      paragraphs.push(`<h${level}>${html}</h${level}>`);
      i += 1;
      continue;
    }

    // List. Accumulate consecutive list items.
    if (/^\s*[-+*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < rawBlocks.length) {
        const itemMatch = rawBlocks[i]!.match(/^\s*(?:[-+*]|\d+[.)])\s+(.*)$/);
        if (!itemMatch) break;
        items.push(`<li>${renderInline(escapeHtml(itemMatch[1]!), refs)}</li>`);
        i += 1;
      }
      paragraphs.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    // Blockquote. Accumulate consecutive quoted lines.
    if (/^\s*>\s?/.test(line)) {
      const lines: string[] = [];
      while (i < rawBlocks.length && /^\s*>\s?/.test(rawBlocks[i]!)) {
        lines.push(rawBlocks[i]!.replace(/^\s*>\s?/, ''));
        i += 1;
      }
      paragraphs.push(
        `<blockquote>${renderInline(escapeHtml(lines.join(' ')), refs)}</blockquote>`,
      );
      continue;
    }

    // Plain paragraph (accumulate until a blank line or a new block).
    const buffer: string[] = [line];
    i += 1;
    while (i < rawBlocks.length && rawBlocks[i]!.trim() !== '') {
      if (
        /^(#{1,6})\s+/.test(rawBlocks[i]!) ||
        /^\s*(?:[-+*]|\d+[.)])\s+/.test(rawBlocks[i]!) ||
        /^```/.test(rawBlocks[i]!)
      ) {
        break;
      }
      buffer.push(rawBlocks[i]!);
      i += 1;
    }
    paragraphs.push(`<p>${renderInline(escapeHtml(buffer.join(' ')), refs)}</p>`);
  }

  return { html: paragraphs.join('\n'), refs };
}
