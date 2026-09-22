# Libraries

A **library** is a storage location that Cairn catalogs in place. It is any
existing directory the user registers — for example `/mnt/photos`,
`/home/me/Documents`, or a removable drive mounted under `/media`. Cairn never
copies media into its own storage.

## Lifecycle

### Creating a new ("empty") library

The user chooses a directory. Cairn creates `<dir>/.cairn/` containing a
persistent library identifier, configuration, and the library's SQLite database.

### Adopting an existing library

A fresh Cairn installation scanning the filesystem detects an existing
`<dir>/.cairn/` and offers an "Open existing library" workflow. Metadata is
reused; nothing is reprocessed unless it has changed.

### Offline libraries

If the backing storage disappears (disk unplugged, network share unmounted),
the library moves to **offline** status. Its metadata, tags, albums, memories,
permissions, and shares are retained and still browsable (media streams fail
retrievably). When the disk is reconnected — even at a different mount path —
Cairn recognizes the same library through its identifier and reconciles only
what changed.

## Identity

Library identity is **not** the mount path. It is a randomly generated
persistent identifier stored in `<library>/.cairn/library.json` (or equivalent),
used together with filesystem/volume identity where available. This enables:

- reconnection at a different path,
- multiple libraries on one device,
- safe cross-library separation,
- cross-library isolation for permissions.

## Metadata directory

Everything Cairn generates for a library lives in `<library>/.cairn/`:

```text
.cairn/
├── library.json       identity, schema version, configuration
├── library.db         library-level SQLite database
├── thumbnails/        derived previews
├── index/             indexer state and journals
├── embeddings/        optional ML embeddings
├── faces/             optional face data
├── jobs/              persisted job state
└── metadata/          extracted metadata cache
```

`.cairn/` is never indexed and never treated as user media.

## Future operations (planned)

- Registration, sync, and health status per library.
- Safe read/write enforcement: writes go through the storage layer, never
  through raw paths in handlers.
- Path traversal prevention is part of every filesystem-facing operation.