# ADR-0015 — Memories as block documents with non-destructive image references

Status: accepted

## Context

Memories were single Markdown bodies. Turning them into photo stories —
sections of library photos with layouts, captions, slideshows and edits —
needed a model that (a) keeps Markdown canonical for text, (b) lets the same
photo appear in many memories with independent captions and edits, (c) never
modifies originals ([ADR-0004](0004-in-place-library-storage.md)), (d) is
reproducible by a future native client from the API alone, and (e) survives
concurrent editing from several tabs or devices.

## Decision

1. **A memory is an ordered list of typed blocks** stored relationally
   (`memory_blocks`, `memory_images`) in the library database, not as an
   HTML or JSON blob. Text blocks hold Markdown; image blocks hold a layout,
   slideshow settings and ordered image references.
2. **Images are references with memory-scoped presentation.** A
   `memory_images` row points at a library file (no foreign key, so a missing
   original never cascades away the reference) and carries the caption and
   edits. Captions never touch the file's own metadata.
3. **Edits are a declarative pipeline** — orientation, rotation, normalized
   crop, filter preset, adjustments — defined as CSS filter primitives so the
   browser renders them with CSS and the server reproduces them exactly.
4. **Edited copies are optional derived media** in the reserved
   `.cairn/memory-media/` directory, one per memory image, valid only while
   their edit signature matches, garbage collected only when unreferenced,
   claimed with a marker file and never written over a path Cairn did not
   create.
5. **Writes are whole-document and revision-checked.** The web client saves
   the full ordered block list with `base_revision`; a stale write is a 409.
   Granular endpoints exist for other clients and are implemented as
   load–mutate–save of the same document, so there is one write path.
   Block and image IDs may be client-minted.
6. **Legacy bodies migrate in place** on database open (one text block),
   and the legacy single-body API remains for older clients.
7. **The web editor has no new dependencies.** Live Markdown editing is a
   contenteditable element whose text is always the Markdown source,
   re-highlighted in place; markers are hidden by CSS when a block is not
   focused.

## Consequences

- Per-image captions, edits and order are queryable, indexable and
  independently editable; "memories using this photo" is an index lookup.
- Autosave is simple and conflict-safe at the cost of sending the whole
  block list (bounded by debounce and version coalescing).
- Derived copies cost disk only when a user opts in and only for edited
  images; they are regenerable and can be deleted freely.
- Two filter tables (Go and TypeScript) must be kept in sync.
- Thumbnails are produced without EXIF orientation (pre-existing behaviour),
  so for rotated phone photos a crop previewed over a thumbnail can differ
  slightly from the full image; full images and edited copies are correct.
