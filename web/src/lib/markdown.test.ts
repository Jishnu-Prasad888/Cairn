import { describe, expect, it } from 'vitest';

import { extractRefs, renderMarkdown } from './markdown';

const REF_TYPES = ['media', 'memory', 'album', 'person', 'tag'] as const;

describe('renderMarkdown', () => {
  it('renders paragraphs and headings', () => {
    const out = renderMarkdown('# Hello\n\nWorld body.');
    expect(out.html).toContain('<h1>Hello</h1>');
    expect(out.html).toContain('<p>World body.</p>');
  });

  it('renders bold, italic, and inline code', () => {
    const out = renderMarkdown('**bold** and *italic* and `code`.');
    expect(out.html).toContain('<strong>bold</strong>');
    expect(out.html).toContain('<em>italic</em>');
    expect(out.html).toContain('<code>code</code>');
  });

  it('renders lists and blockquotes', () => {
    const out = renderMarkdown('- one\n- two\n\n> a quote');
    expect(out.html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(out.html).toContain('<blockquote>a quote</blockquote>');
  });

  it('escapes raw HTML (XSS safety)', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('renders safe links and blocks javascript: URLs', () => {
    const out = renderMarkdown('[ok](https://example.com) [bad](javascript:alert(1))');
    expect(out.html).toContain('href="https://example.com"');
    expect(out.html).not.toContain('javascript:');
  });

  it('turns internal references into ref anchors', () => {
    const out = renderMarkdown('[[media:abc123|The cove]]');
    expect(out.html).toContain('class="md-ref md-ref-media"');
    expect(out.html).toContain('data-ref-type="media"');
    expect(out.html).toContain('The cove');
  });

  it('exposes parsed internal refs from the preview', () => {
    const out = renderMarkdown('See [[album:a1]] and [[person:p2|Maya]].');
    expect(out.refs).toEqual([
      { type: 'album', id: 'a1', label: '' },
      { type: 'person', id: 'p2', label: 'Maya' },
    ]);
  });

  it('ignores unknown or empty references', () => {
    const out = renderMarkdown('[[wat:ignored]] and [[media:|]] and plain [[bracket]] text.');
    expect(out.refs).toHaveLength(0);
  });

  it('renders a horizontal rule and code fence', () => {
    const out = renderMarkdown('---\n\n```go\nfmt.Println("hi")\n```');
    expect(out.html).toContain('<hr>');
    expect(out.html).toContain('<pre><code>');
    expect(out.html).toContain('fmt.Println');
  });

  it('refuses markdown links with unbalanced or unsafe targets', () => {
    const out = renderMarkdown('[x](https://ok.example) [y](data:text/html,boom)');
    expect(out.html).toContain('href="https://ok.example"');
    expect(out.html).not.toContain('data:text/html');
  });
});

describe('extractRefs', () => {
  it('finds distinct references with optional labels', () => {
    const refs = extractRefs('A [[media:m1|One]] plus [[album:a2]] plus [[media:m1|One again]].');
    expect(refs).toEqual([
      { type: 'media', id: 'm1', label: 'One' },
      { type: 'album', id: 'a2', label: '' },
    ]);
  });

  it('ignores references inside fenced code blocks', () => {
    const refs = extractRefs('```\n[[media:fake]]\n```');
    expect(refs).toHaveLength(0);
  });

  it('supports every documented reference type', () => {
    const body = REF_TYPES.map((t) => `[[${t}:id]]`).join(' ');
    const refs = extractRefs(body);
    expect(refs.map((r) => r.type)).toEqual(REF_TYPES);
  });
});
