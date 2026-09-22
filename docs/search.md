# Search

Implemented (Phase 9). Search is served by the per-library FTS5 virtual table
(`fts_files`) over file paths, with a hardened query parser shared by file and
memory search.

## Endpoint

`GET /api/v1/libraries/{libraryID}/search`

Query parameters:

| Param      | Meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| `q`        | Search expression (FTS5). Empty = browse all files.            |
| `type`     | Media type filter: `photo`, `video`, `audio`, `document`, `other`. |
| `folder`   | Folder path prefix filter (e.g. `holiday/Japan`).              |
| `tag`      | Tag name filter (case-insensitive).                            |
| `album`    | Album ID filter.                                               |
| `min_size` | Minimum file size in bytes.                                    |
| `max_size` | Maximum file size in bytes.                                    |
| `from`     | `mod_time` lower bound (RFC3339).                              |
| `to`       | `mod_time` upper bound (RFC3339).                              |
| `cursor`   | Pagination cursor returned as `next_cursor`.                   |
| `limit`    | Page size, default 50, max 200.                                |

Response:

```json
{ "files": [ ...file objects... ], "next_cursor": "...", "total": 42 }
```

Malformed queries (unbalanced quotes/parens, dangling operators, an
inexpressible "everything except X" expression, or an impossible size range)
return HTTP 400 with code `BAD_REQUEST`.

## Query syntax

Each term is quoted and prefix-matched by default:

- `beach` matches `beach.jpg`, `holiday/beach_party`, ...
- `holiday/beach` matches files under a `holiday` folder whose name starts with
  `beach`.
- `"moon landing"` matches the exact phrase.
- `*` after a term keeps prefix matching explicit; a bare `*` or
  `.`/`/`/`-` inside a term is stripped.

Operators:

- `a AND b` — both must match (an implicit AND applies between adjacent terms).
- `a OR b` — either may match.
- `a -b` / `a NOT b` — results must match `a` but not `b`. Negation needs a
  positive expression to attach to (`-a` alone means "everything except a",
  which FTS5 cannot express and is rejected).

The query parser (`internal/fts`) bounds input at 1024 bytes, 64 terms, and 32
words per phrase before building the FTS5 expression.

## Filters

`type`, `folder`, `tag`, `album`, `min_size`, `max_size`, `from`, and `to`
combine with `q` (or stand alone in browse mode) and all result in
single-row-filtered keyset pagination.

## Capabilities

`/search` requires `read` on the library (or the `folder` subtree when a
`folder` filter is supplied), enforced per request alongside every other
resource handler. On public shares the same `shareCan` path applies.

## Memories

`GET /api/v1/libraries/{libraryID}/memories?q=...` uses the same
`fts.BuildExpression` parser over `fts_memories`; an empty `q` falls back to a
plain browse. Future memory search gets the same operators for free.

## Future unification

The query layer is designed so additional similarity signals can be added
without rewriting the system:

- face similarity
- perceptual similarity
- semantic embeddings

These feed the same result model so the API shape stays stable.