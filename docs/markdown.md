# Markdown

This documents the planned Markdown syntax for Cairn memories (the memory editor
lands in a later phase; the syntax is fixed now so documents stay compatible).

## Standard Markdown

Cairn uses CommonMark for formatting: headings, emphasis, lists, links, images,
code blocks, tables, blockquotes, task lists.

## Internal references

Wikilink-style references resolve against Cairn objects and are verified when
rendered:

```markdown
[[media:<id>]]      → a photo, video, or file
[[memory:<id>]]     → another memory
[[album:<id>]]      → an album
[[person:<id>]]     → a person
```

When the referenced object is titled, this renders as a clickable card or inline
link that navigates within Cairn. Users create these through the picker UI; the
syntax is documented so hand-written links also work.

## Media embedding

Embedding a media object renders it inline (thumbnail grid for photos, a video
player, or a file download chip):

```markdown
![[media:<id>]]
```

## Extensions

Additional dialects (frontmatter metadata, comments) will be documented here as
they are implemented. The Markdown dialect will be tested and versioned with the
memory editor.