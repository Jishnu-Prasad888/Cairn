# Markdown

This documents the Markdown dialect used by Cairn memories. The dialect is
implemented in the web editor's renderer and the Go reference parser
(`internal/markdown`), and is versioned with the memory editor.

## Standard Markdown subset

Cairn renders a safe, bounded subset of CommonMark:

- ATX headings (`#` to `######`)
- paragraphs and hard breaks
- unordered (`- `) and ordered (`1. `) lists
- blockquotes (`> `)
- fenced code blocks (```` ``` ````)
- inline code, bold, and italic
- links `[text](url)` and safe schemes only (`http:`, `https:`, `mailto:`)
- thematic breaks (`---`)

Raw HTML is **escaped, never rendered**. Any other Markdown extension renders
as escaped text rather than being dropped.

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

## Media embedding

Not yet implemented. A future phase will render `![[media:<id>]]` as an inline
thumbnail grid, video player, or download chip.

## Extensions

Additional dialects (frontmatter metadata, comments) will be documented here as
they are implemented. The renderer is intentionally conservative so untrusted
content — including memory bodies — can never inject markup.