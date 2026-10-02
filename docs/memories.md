# Memories

A memory is a personal story told with words and photos from the library — a
trip, a year, a person, a project log. Memories were introduced in Phase 8 as
single Markdown documents and redesigned as **notebook-style block documents**
(schema v8, [ADR-0015](adr/0015-memory-block-documents.md)). There is no
artificial length limit.

## The model

```text
Memory ── metadata: title, date, description, location, tags, cover
   └── blocks[]                     ordered, each with a stable id
         ├── text block   → Markdown (canonical content)
         └── image block  → layout + slideshow
               └── images[]          ordered memory images
                     ├── reference to a library file (never a copy)
                     ├── caption        (belongs to this memory only)
                     ├── crop, rotation, filter, adjustments (non-destructive)
                     └── derived copy   (optional, see "Edited copies")
```

Relational storage in the library database (`<library>/.cairn/library.db`):

| Table                  | Holds                                                         |
| ---------------------- | ------------------------------------------------------------- |
| `memories`             | metadata, `revision`, legacy `body`, `search_text`            |
| `memory_blocks`        | `id`, `memory_id`, `position`, `type`, `markdown`, `layout`, `slideshow`, `slideshow_interval` |
| `memory_images`        | `id`, `block_id`, `position`, `source_file_id`, caption, edits, `derived_id` |
| `memory_derived_media` | edited copies: owner image, source, `rel_path`, `edit_signature`, size |
| `memory_tags`          | memory ↔ library tag                                          |
| `memory_versions`      | history; `document` is a JSON snapshot of the blocks           |
| `memory_refs`          | `[[type:id]]` links from text blocks + one `media` ref per image |

`memory_images.source_file_id` deliberately has **no foreign key** to
`indexed_files`: a missing or re-indexed original must never cascade away a
memory's caption, edits or ordering.

Block and image IDs may be minted by the client (8–64 characters of
`[A-Za-z0-9_-]`; the web client uses 32 hex characters), so a block can be
addressed before it is first saved. An ID already owned by another memory is
rejected, never taken over.

Limits exist only to bound abuse: 5 000 blocks per memory, 500 images per
image block, 2 MiB of Markdown per text block, 2 000 characters per caption.

## Text blocks

Markdown is the canonical content; see [markdown.md](markdown.md) for the
supported syntax and the safety rules. The legacy `body` field of a memory is
the Markdown of all text blocks joined by a blank line, kept for older clients
and for `[[type:id]]` reference extraction.

## Image blocks

An image block is a visual section, not a single image. It has:

- **layout** — `grid` (default; configurable), `hero`, `masonry`,
  `two_column`, `filmstrip`, `featured`. Layouts are rendered by clients; the
  web client keeps them in a registry (`web/src/memories/layouts`) so a new
  layout is one entry plus CSS. Each adapts per breakpoint rather than
  shrinking: grid goes 3 → 2 → 1 columns, masonry falls back to a single
  column on phones, featured becomes a full-width lead over a two-up grid.
- **slideshow** — `{enabled, interval_seconds}`. `interval_seconds: null`
  inherits the viewer's **Memory slideshow interval** setting (default 15 s);
  a number (3–3600) overrides it for this section only. When enabled, readers
  can switch between *Layout view* and *Slideshow*.

Images are references to library photos or videos, picked from the library
with the media picker (search, folders, albums, tags, people, favorites, date
range, multi-select). Nothing is uploaded or copied. Videos can be placed in
sections but cannot be edited.

### Captions

A caption belongs to the memory image, not to the photo. The same photo can
appear in two memories with different captions; the photo's own library note
(`file_notes`) is never touched. Captions are indexed for memory search.

In Preview, captions of a hero or lone featured image sit underneath as an
editorial line; in tiled layouts they appear on hover (and keyboard focus) as
a soft gradient along the bottom edge. Touch screens show a small caption
indicator; tapping reveals the caption, and *Open image* shows it in full.

### Removing an image

*Remove from memory* deletes the `memory_images` row only. No memory
operation deletes, moves, renames or rewrites a library file.

## Image edits

Edits are presentation data on the memory image, applied in a fixed order by
every renderer:

1. EXIF orientation (what browsers already show for the original)
2. `rotation` — 0, 90, 180 or 270, clockwise
3. `crop` — `{x, y, width, height}` normalized (0–1) in the rotated image;
   `null` means no crop, and a full-frame crop is normalized to `null`
4. `filter` preset — `original`, `warm`, `cool`, `bw`, `soft`, `contrast`
5. `adjustments` — `brightness`, `contrast`, `saturation`, each −100…100

Presets and adjustments are sequences of CSS filter primitives (`brightness`,
`contrast`, `saturate`, `grayscale`, `sepia`, `hue-rotate`). The web client
applies them with CSS `filter`; the server reproduces the W3C Filter Effects
math when it renders an edited copy, so both match. The two tables live in
`internal/memories/edits.go` and `web/src/memories/edits.ts` and must stay in
sync.

The image editor offers crop (free, Original, 1:1, 4:3, 3:2, 16:9; handles,
drag, arrow keys), rotate left/right, three sliders and the presets, with
undo/redo and *Reset to original*. It edits one image; the separate *image
section* editor changes which photos a section holds, their order, captions,
layout and slideshow.

## Edited copies

Setting: **Settings → Memories → When editing library photos inside
memories**.

- *Keep edits as memory-only presentation* (default) — no file is written.
- *Also save edited copies in the library* — every memory image with
  non-default edits gets a rendered JPEG (quality 90, full resolution) at

  ```text
  <library>/.cairn/memory-media/<memory-id>/<memory-image-id>-<signature>.jpg
  ```

Rules:

- **No change, no copy.** An image without edits always references the
  original.
- **Per memory image.** Two memories editing the same photo get two
  independent copies; changing one never affects the other.
- **Valid only while it matches.** The copy's `edit_signature` hashes the
  edits and source file. Changing the edits detaches it and renders a new
  one; resetting all edits detaches it and the image references the original
  again.
- **Garbage collected only when unreferenced.** Detached copies (rows and
  files) are removed; copies of soft-deleted memories stay. Version snapshots
  store edit parameters, not files, so restoring a version re-renders.
- **Encrypted like thumbnails** when at-rest encryption is on.
- **Never indexed** — `.cairn/` is excluded from scanning — and never shown as
  a user folder.

The reserved directory, collision handling and lifecycle are described in
[storage.md](storage.md#memory-media).

## Editing experience (web)

The editor is a notebook: one continuous page; between blocks and at the end
a quiet **+ Text / + Image** inserter (on hover or focus; always visible on
touch). The focused block shows a faint boundary, a drag handle and a ⋯ menu;
other blocks melt into the page.

- **Live Markdown.** Text blocks are styled in place while typing — headings
  grow, bold is bold, quotes indent — and Markdown markers are hidden in
  unfocused blocks. *Markdown* in the toolbar shows markers everywhere
  (source mode). Paste is always plain text.
- **Edit / Preview.** Preview removes every control and shows the memory as
  an article: centered reading column, book serif, Handlee title, wide image
  sections, editorial captions. The default mode is a setting.
- **Menus.** Right-click (desktop), long-press (touch) or the ⋯ button open
  the same actions — text: move up/down, duplicate, delete; image section:
  edit section, add photos, move, duplicate, delete; photo: open, edit image,
  caption, replace, use as cover, add photos, move left/right, remove from
  memory. Nothing is right-click-only.
- **Reordering.** Drag the handle, use the menu, or Alt+↑/Alt+↓. Photos
  inside a section reorder by drag, ← / →, or to beginning/end.
- **Keyboard.** ↑/↓ at the first/last line moves between blocks; Enter on a
  focused image section edits it; Delete removes it; Shift+F10 or the Menu
  key opens the block menu; Ctrl/Cmd+S saves now; Ctrl/Cmd+Z and
  Ctrl/Cmd+Shift+Z undo/redo typing inside a block and structural changes
  (insert, delete, move, image edits) elsewhere. Deleting shows an *Undo*
  toast.

## Slideshow behaviour

- Advances every interval (section override or the user setting, default
  15 s) and wraps around.
- Previous/next buttons, ←/→ when focused, and swipe move immediately and
  **restart the countdown**, so a chosen photo gets a full interval. They do
  not stop the show.
- Pauses while hovered or focused (so it never moves under someone reading),
  while the page is hidden, and while scrolled out of view — no timers run
  for invisible shows. The Pause/Play button stops it for good.
- Slides are announced to screen readers only after manual navigation.
- With `prefers-reduced-motion`, slides change without a crossfade.

## Saving

- **Autosave** is debounced (≈0.8 s after typing stops, ≈0.15 s after
  structural changes) — never a request per keystroke. All writes go through
  one serialized queue: metadata `PATCH`, then document `PUT`.
- **Revisions.** Every write carries `base_revision`; a stale write gets
  `409` with `details.current_revision` and the editor offers *Load the other
  version* or *Keep mine* — it never overwrites silently.
- **Drafts.** Unsaved work is mirrored to `localStorage`. On the next load a
  draft based on the current revision is restored automatically; a draft
  based on an older revision is offered, not applied.
- **Offline.** Network failures show *Offline — will retry* and retry every
  5 s and when the browser comes back online.
- **Versions.** Every save is recorded in `memory_versions` with a JSON
  snapshot. Rapid document saves within two minutes are coalesced into the
  latest version (the creation version is never overwritten). *History*
  lists versions and restores one as an ordinary, undoable edit.
- **Autosave off** (setting): changes stay local until *Save* or Ctrl/Cmd+S.
- The save state is shown as *Saved*, *Saving…*, *Unsaved changes*,
  *Offline — will retry*, *Save failed* or *Changed elsewhere*.

## Missing and forbidden media

Every image in a response carries a `media` view:

| `status`    | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `present`   | available; URLs included                        |
| `missing`   | the indexer no longer finds the file            |
| `deleted`   | the original is in the trash                    |
| `forbidden` | the viewer lacks read permission on the file    |
| `unknown`   | the file id is not in this library's index      |

Unavailable images keep their caption, order and place in the layout and
render as *Image unavailable*. Forbidden media expose no name or URLs.

When a memory is opened by someone who can edit it, images whose original is
gone are re-attached to a **present file with the same content hash** (a
moved or re-indexed original); the revision is bumped so stale editors reload
rather than writing the old reference back. A file that reappears at its old
id is simply available again.

## Permissions

Memories use the existing resource model ([permissions.md](permissions.md)):
`read`/`create`/`edit`/`delete` on the library or on the memory entity key
`m:<library>:<memory>`. In addition, **adding** or **replacing** a photo
requires `read` on that file, and a memory never reveals a referenced file
the viewer cannot read. Original URLs are only included with `download`.

## Search

Memory search (`GET .../memories?q=`) uses FTS5 over the title and
`search_text`: every text block, every caption, the description, the
location and the tag names. Captions are indexed for the memory, never for the
source photo.

## Settings

Per account, stored on the server (`GET/PATCH /api/v1/settings/memories`):

| Setting              | Values                                  | Default |
| -------------------- | --------------------------------------- | ------- |
| `slideshow_interval` | 3–3600 s (UI offers 5/10/15/20/30/60)   | 15      |
| `edited_copies`      | `true` / `false`                        | `false` |
| `default_layout`     | any layout id                           | `grid`  |
| `default_mode`       | `edit` / `preview`                      | `edit`  |
| `autosave`           | `true` / `false`                        | `true`  |

## Migration from single-body memories

Opening a library database at schema v8 converts every pre-v8 memory once:
its Markdown body becomes a single text block (with the memory's original
timestamps), `search_text` is filled and the FTS triggers are switched to
index it. Nothing is deleted: titles, dates, bodies, versions, timestamps and
`[[type:id]]` links (including `[[media:…]]`) are preserved, and the memory
reads exactly as before. `[[media:id]]` links stay links; they are not turned
into image blocks, because a link is not the same intent as a photo section.

The legacy API keeps working: `POST` with a `body` creates a one-text-block
memory, and `PUT /memories/{id}` with a body updates that block. A memory with
image sections or several text blocks answers `409` to the legacy `PUT`
instead of being flattened.

## HTTP API

All under `/api/v1/libraries/{id}/memories`; see
[openapi.yaml](openapi.yaml) and [api.md](api.md).

| Method | Path                                             | Purpose                                   |
| ------ | ------------------------------------------------ | ----------------------------------------- |
| GET    | `/memories`                                      | List (keyset paginated, `?q=` search)     |
| POST   | `/memories`                                      | Create (`body` or `blocks`)               |
| GET    | `/memories/{memoryID}`                           | Memory with blocks and media views        |
| PATCH  | `/memories/{memoryID}`                           | Metadata (title, date, location, tags, cover…) |
| PUT    | `/memories/{memoryID}/document`                  | Replace all blocks (what autosave sends)  |
| PUT    | `/memories/{memoryID}`                           | Legacy single-body save                   |
| DELETE | `/memories/{memoryID}`                           | Soft delete                               |
| POST   | `/memories/{memoryID}/restore`                   | Restore                                   |
| POST   | `/memories/{memoryID}/blocks`                    | Insert a block (`index`, `file_ids`)      |
| PUT    | `/memories/{memoryID}/blocks/order`              | Reorder blocks                            |
| PATCH  | `/memories/{memoryID}/blocks/{blockID}`          | Markdown, layout, slideshow               |
| DELETE | `/memories/{memoryID}/blocks/{blockID}`          | Delete a block (references only)          |
| POST   | `/memories/{memoryID}/blocks/{blockID}/duplicate`| Duplicate (references, not media)         |
| POST   | `/memories/{memoryID}/blocks/{blockID}/images`   | Add photos to a section                   |
| PUT    | `/memories/{memoryID}/blocks/{blockID}/images/order` | Reorder photos                        |
| PATCH  | `/memories/{memoryID}/images/{imageID}`          | Caption, edits, replace source            |
| DELETE | `/memories/{memoryID}/images/{imageID}`          | Remove from memory                        |
| GET    | `/memories/{memoryID}/images/{imageID}/derived`  | The edited copy (JPEG)                    |
| GET    | `/memories/{memoryID}/versions`                  | Version list                              |
| GET    | `/memories/{memoryID}/versions/{version}`        | One version, with its blocks              |
| GET    | `/memories/{memoryID}/refs`                      | Internal references                       |

Every mutation returns the whole memory (`{"memory": …, "warnings"?: […]}`)
with its new `revision`, and accepts an optional `base_revision` (JSON body,
or query string for `DELETE`).

## Internal references

`[[type:id]]` wikilinks reference other Cairn objects (`media`, `memory`,
`album`, `person`, `tag`) with an optional label, e.g.
`[[album:xyz|Rye trip]]`. On every save they are re-extracted from the text
blocks into `memory_refs`, together with a `media` reference for every image
in the memory, so "which memories use this photo" is one indexed query. The
editor's *Link…* picker inserts references at the caret.
