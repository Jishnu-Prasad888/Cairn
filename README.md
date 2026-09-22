# Cairn

> A small, beautiful, personal digital place that quietly organizes everything you want to keep.

Cairn is a self-hosted personal media, file, and memory server. It brings together
ideas from Google Photos, Google Drive, Obsidian, and personal digital archives into
one calm, self-hosted application.

The most important architectural idea:

> **Cairn catalogs and manages existing media *in place*. It never copies, moves,
> recompresses, or rewrites your original files.**

Your filesystem is the source of truth for actual media files. Point Cairn at a
directory full of years of photos and videos and it indexes them where they are.

## Current status

Phase 0 (repository and architecture) — in progress.

The foundation is in place:

- Go API server with clean package boundaries
- SQLite with WAL, migrations, and a pure-Go driver (cross-compiles without CGO)
- Embedded React + TypeScript frontend (built into a single binary)
- Health and version endpoints, consistent JSON error envelopes, request IDs
- Configuration via environment variables
- Build system (`Makefile`), container image, and CI
- Documentation and architecture decision records

Later phases add authentication, storage libraries, the incremental indexer, media
processing, search, memories, authorization, sharing, backups, and optional local ML.

See [docs/roadmap.md](docs/roadmap.md) for the full plan.

## Quick start

### From source

```sh
make build          # builds web/, embeds it, compiles bin/cairn
./bin/cairn         # serves http://127.0.0.1:8715
```

The server database and state live in `$XDG_DATA_HOME/cairn`
(`~/.local/share/cairn`). Override with `CAIRN_DATA_DIR`.

### Docker

```sh
docker build -t cairn .
docker run -d \
  --name cairn \
  -p 8715:8715 \
  -v cairn-data:/data \
  cairn
```

### Development

```sh
make web-install    # npm install once
make dev            # run the backend (serves web/dist)
make web-dev        # in another terminal: Vite dev server with /api proxy
```

See [docs/development.md](docs/development.md) for details.

## Configuration

All settings use the `CAIRN_` prefix.

| Variable         | Default                            | Description                             |
| ---------------- | ---------------------------------- | --------------------------------------- |
| `CAIRN_HTTP_ADDR`| `127.0.0.1:8715`                   | HTTP listen address                     |
| `CAIRN_DATA_DIR` | `$XDG_DATA_HOME/cairn`             | Server-level data directory             |
| `CAIRN_LOG_LEVEL`| `info`                             | `debug`, `info`, `warn`, or `error`     |
| `CAIRN_WEB_DIST` | *(embedded frontend)*              | Serve an on-disk build instead (dev)    |

## Repository layout

```text
cmd/cairn/             entrypoint
internal/
  config/              environment configuration
  db/                  SQLite, pragmas, schema migrations
  httpapi/             HTTP API v1 and request middleware
  logging/             structured logging
  version/             build metadata
  webui/               embedded single-page app server
web/                   React + TypeScript frontend
docs/                  architecture, API, operations documentation
```

## API

The API is REST/JSON under `/api/v1`. Two endpoints exist today:
`GET /api/v1/health` and `GET /api/v1/version`. The complete contract is
maintained in [docs/openapi.yaml](docs/openapi.yaml), with prose in
[docs/api.md](docs/api.md). A future client (React Native, desktop, CLI) can be
built against the documented API without reading Go source.

## Documentation

- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [API](docs/api.md)
- [Storage model](docs/storage.md)
- [Libraries](docs/libraries.md)
- [Database](docs/database.md)
- [Indexing](docs/indexing.md)
- [Deployment](docs/deployment.md)
- [Docker](docs/docker.md)
- [Roadmap](docs/roadmap.md)
- Architecture decision records in [docs/adr](docs/adr)

## License

Not yet decided. Reviewers should choose an open-source license before public
release.