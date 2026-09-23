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
    ├── embeddings/             optional ML embeddings
    ├── faces/                  optional face data
    ├── jobs/                   persisted background job state
    └── metadata/               extracted metadata cache
```

The `.cairn/` name is the project's chosen internal metadata directory. It is
documented here and used consistently across the codebase and documentation.

Portability rule: a library is self-describing. A fresh Cairn installation can
detect an existing library, adopt it, and reuse its metadata instead of
reprocessing everything. This is expanded in [libraries.md](libraries.md).

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