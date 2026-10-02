# Storage

## Principles

1. **The filesystem is the source of truth for media bytes.**
2. Cairn **never silently modifies originals.** It will not move, copy, resize,
   recompress, rotate, or rewrite metadata unless the user explicitly requests
   an operation with that intent.
3. **All application-generated data is derived** and kept out of the way of the
   user's files.

## Three kinds of data

| Kind          | Where it lives                          | Owner                   |
| ------------- | --------------------------------------- | ----------------------- |
| Original media| user's directories (anywhere)           | users and their disks   |
| Library metadata | `<library>/.cairn/`                  | Cairn                   |
| Server data   | `CAIRN_DATA_DIR`                        | Cairn                   |

### Original media

Cairn indexes existing directories in place. There is no proprietary storage
volume and no import step that copies files.

### Library metadata directory

Each library carries its own metadata inside the user-visible library, in a
single dot-directory:

```text
/mnt/photos/
├── 2022/
├── IMG001.jpg
└── .cairn/
    ├── library.db              library-level SQLite database
    ├── thumbnails/             derived previews
    ├── index/                  indexer state and change journals
    ├── embeddings/             optional ML embeddings (future)
    ├── faces/                  optional face data (future)
    ├── jobs/                   persisted background job state
    ├── metadata/               extracted metadata cache
    └── memory-media/           optional edited copies of memory photos
```

The `.cairn/` name is the project's chosen internal metadata directory. It is
documented here and used consistently across the codebase and documentation.

Portability rule: a library is self-describing. A fresh Cairn installation can
detect an existing library, adopt it, and reuse its metadata instead of
reprocessing everything. This is expanded in [libraries.md](libraries.md).

ML similarity signatures are derived data and live as a table inside
`library.db` (not as files), so they follow the library and are captured by any
backup that includes `.cairn/`. They can be discarded and regenerated with a
similarity pass. See [ml.md](ml.md).

### Server data

Data that belongs to the server instance, not to any library, lives in
`CAIRN_DATA_DIR`:

```text
cairn-data/
└── cairn.db            server-level SQLite database
```

Backups are written wherever `CAIRN_BACKUP_DIR` points (see docs/backups.md).
Backup archives are meant to restore a Cairn installation, not to be pulled into
the indexer as media; never place `CAIRN_BACKUP_DIR` inside a library root.

## Memory media

When a user turns on *Settings → Memories → Also save edited copies in the
library*, edited memory photos are rendered to:

```text
<library>/.cairn/memory-media/
├── .cairn-memory-media                 marker: claims the directory for Cairn
└── <memory-id>/
    └── <memory-image-id>-<signature>.jpg
```

- **Reserved namespace.** The copies live inside the library (so they travel
  and back up with it) but inside `.cairn/`, which the indexer never scans,
  so they are never indexed as new media and never appear as a user folder.
- **Collision safety.** Cairn creates `memory-media/` and writes the marker
  file. If that path already exists as a file, a symlink, or a non-empty
  directory without the marker, Cairn treats it as someone else's: it writes
  nothing there, moves nothing, overwrites nothing, and the editor reports
  that edited copies could not be created. An empty pre-existing directory is
  claimed.
- **Stable identity.** Names come from IDs, never from user-visible file
  names: `<memory-image-id>` is the memory image that owns the copy and
  `<signature>` a hash of its edits and source, so copies never collide with
  each other or with user files. `memory_derived_media` records the original
  file id, memory, memory image, path, edit signature, size and timestamps;
  the caption and edits stay on the memory image.
- **Lifecycle.** A copy exists only for an image with edits, and only while
  the edits match its signature. Unedited images always reference the
  original. Copies no memory image references are deleted (row and file);
  copies of soft-deleted memories are kept. Everything here can be deleted
  by hand — Cairn regenerates what it needs on the next save.
- **Originals are read-only.** Rendering opens the original read-only; its
  bytes, name, location, timestamps and metadata are never changed. This is
  covered by an automated SHA-256 integrity test.
- Encrypted with the at-rest key when encryption is enabled, like
  thumbnails.

## What is never done

- Original media blobs are never stored inside SQLite.
- Thumbnails and previews are never written next to originals outside `.cairn/`.
- Derived data is never stored so that it would be picked up by the indexer as
  new media.
- `.cairn/` is excluded from indexing.

## Duplicate/privacy note

Because derived data is kept inside `<library>/.cairn/`, backing up a library
with its metadata directory captures everything Cairn knows about it. A library
whose `.cairn/` directory is removed is simply a folder of files again — nothing
about the originals is lost, only Cairn's knowledge of them.