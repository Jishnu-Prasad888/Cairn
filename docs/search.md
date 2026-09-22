# Search

Planned (Phase 7 for full-text; dedicated search phases later).

## Full-text search

SQLite FTS5 powers search over:

- filenames
- folder paths
- Markdown memory content
- tags
- people
- extracted metadata

## Filters

Search results filter by date, media type, folder, library, tag, person, album,
and memory.

## Future unification

The query layer is designed so additional similarity signals can be added
without rewriting the system:

- face similarity
- perceptual similarity
- semantic embeddings

These feed the same result model so the API shape stays stable.