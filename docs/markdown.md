# Markdown

This documents the Markdown dialect used by the text blocks of Cairn memories
([memories.md](memories.md)). Markdown is the canonical content: the server
stores it verbatim and never stores HTML. The dialect is implemented in the
web renderer (`web/src/lib/markdown.ts`) and the Go reference parser
(`internal/markdown`).

## Standard Markdown subset

Cairn renders a safe, bounded subset of CommonMark:

- ATX headings (`#` to `######`)
- paragraphs; a single newline inside a paragraph is a line break
- `**bold**`, `__bold__`, `*italic*`, `_italic_` (not inside words, so
  `snake_case` stays literal), `~~strikethrough~~`, `` `inline code` ``
- unordered (`- `, `* `, `+ `) and ordered (`1. `) lists, nested by
  indentation
- task lists: `- [ ] todo`, `- [x] done`
- blockquotes (`> `), including multi-paragraph quotes
- fenced code blocks (```` ``` ```` or `~~~`) with an optional language
- tables with a header separator row and `:--`, `:-:`, `--:` alignment
- links `[text](url)` and autolinks `<https://…>`
- thematic breaks (`---`, `***`, `___`)

## Safety

- Raw HTML is **escaped, never rendered**; any unsupported syntax shows as
  escaped text rather than being dropped.
- Link targets are limited to `http:`, `https:`, `mailto:`, `#fragment` and
  relative paths; anything else (`javascript:`, `data:`, protocol-relative
  `//host`) becomes `#`. Links get `rel="noopener noreferrer"`.
- Markdown images `![alt](url)` render as a **link**, never as `<img>`, so a
  memory cannot make a reader's browser fetch an arbitrary remote URL
  (tracking pixels, mixed content). Photos belong in image blocks.
- Code spans and fence contents are escaped and never receive inline
  formatting; a fence's language is reduced to a class name.
- Reference labels are escaped.

## Live editing

The editor highlights Markdown in place while typing
(`highlightMarkdown`): the editable text is always exactly the source, and
markers such as `##`, `**` or `](url)` are wrapped so they can be hidden
while a block is not focused. Paste and drop insert plain text only.

## Internal references

Wikilink-style references resolve against Cairn objects. Reference types:

```markdown
[[media:<id>]]      → a photo, video, or file
[[memory:<id>]]     → another memory
[[album:<id>]]      → an album
[[person:<id>]]     → a person
[[tag:<id>]]        → a tag
```

An optional display label is supported:

```markdown
[[album:xyz|Rye trip]]
[[person:8f2a|Maya]]
```

Rules:

- The type must be one of the five above; unknown or empty references are left
  untouched.
- References inside fenced code blocks are ignored by the extraction logic
  (they are treated as code, not links).
- On every save the backend re-parses the body and persists distinct
  references to the library reference index (`memory_refs`), and returns them
  via `GET /memories/{id}/refs`.

Users normally create references through the editor picker; hand-written links
have the same syntax so documents remain portable.

## Media in memories

Photos and videos are not embedded in Markdown. They live in **image blocks**
between text blocks, with layouts, captions and slideshows — see
[memories.md](memories.md). `[[media:<id>]]` remains a link.

## Extensions

Additional dialects (frontmatter metadata, comments) will be documented here as
they are implemented. The renderer is intentionally conservative so untrusted
content — including memory bodies — can never inject markup.