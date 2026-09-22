# Memories and Markdown

Implemented in Phase 8. Memories are long-form Markdown documents — thoughts,
journal entries, travel logs, essays. There is no artificial short-content
limit. Memories can link to photos, videos, files, other memories, albums,
people, and tags.

## Memory objects

A memory has a title, a Markdown body, an optional detached date
(`memory_date`), soft-delete state (`deleted`), and `created_at`/`updated_at`
timestamps. It lives inside a library.

## Save semantics

- Every save appends a **version** instead of overwriting in place. Version 1
  is written at creation; each update adds version N+1. The current content is
  always the latest version, and old revisions remain recoverable.
- Soft delete marks the memory (and removes it from the FTS index and the
  default list) without destroying versions or references. Restore brings it
  back intact.

## HTTP API

All endpoints are under `/api/v1/libraries/{id}/memories` and require an admin
session:

| Method | Path                                      | Purpose                         |
| ------ | ----------------------------------------- | ------------------------------- |
| GET    | `/memories`                               | List (keyset paginated, `?q=` search) |
| POST   | `/memories`                               | Create (writes version 1)       |
| GET    | `/memories/{memoryID}`                    | Fetch the latest revision       |
| PUT    | `/memories/{memoryID}`                    | Autosave a new revision         |
| DELETE | `/memories/{memoryID}`                    | Soft delete                     |
| POST   | `/memories/{memoryID}/restore`            | Restore a soft-deleted memory   |
| GET    | `/memories/{memoryID}/versions`           | List saved revisions            |
| GET    | `/memories/{memoryID}/versions/{version}` | Fetch one revision by number    |
| GET    | `/memories/{memoryID}/refs`               | List parsed internal references |

See `docs/openapi.yaml` for the full contract.

## Editor

The web app provides an Obsidian-inspired editor:

- split view: Markdown source on the left, rendered preview on the right
- autosave on a short debounce, with explicit save states (idle / saving /
  saved / error)
- version history dropdown to preview and restore earlier revisions
- a reference toolbar that inserts `[[type:id]]` wikilinks at the caret
- cornership: deleted memories are removed locally on delete

## Internal references

`[[type:id]]` wikilinks reference other Cairn objects. The parser accepts
`media`, `memory`, `album`, `person`, and `tag` types, with an optional display
label:

```markdown
[[media:abc123]]       → a photo, video, or file
[[album:xyz|Rye trip]] → an album, labelled "Rye trip"
[[person:8f2a]]        → a person
```

On every save the store re-parses the body and persists the references to the
library reference index (`memory_refs`), so both the `/refs` endpoint and
bidirectional navigation have accurate data. The editor's picker inserts
templates at the caret; the reference verification ("does this id exist?")
model is part of the broader object-reference work tracked for later phases.