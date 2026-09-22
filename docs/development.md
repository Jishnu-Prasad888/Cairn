# Development

This project is a single-process Go backend with an embedded React frontend.
Both sides must be developed together but can be run separately.

## Prerequisites

- Go 1.26+
- Node.js 22+ and npm
- Docker (optional, for container work)
- `golangci-lint` (recommended; CI installs it automatically)

## First-time setup

```sh
make web-install   # npm install in web/
```

## Common workflows

### Run the backend with a locally built frontend

```sh
make build        # compiles web/ and embeds it into bin/cairn
./bin/cairn
```

### Backend-only iteration

```sh
make dev          # go run with CAIRN_WEB_DIST=web/dist
```

`make dev` serves whatever is currently in `web/dist`. Rebuild the frontend with
`make web-build` to see changes without restarting the backend.

### Frontend-only iteration with hot reload

Terminal 1:

```sh
make dev          # Go backend on :8715
```

Terminal 2:

```sh
make web-dev      # Vite dev server on :5173, proxies /api to :8715
```

Open http://127.0.0.1:5173.

## Build system

```text
make build          production single binary (bin/cairn)
make test           all tests
make test-go        Go tests
make test-web       frontend tests
make lint           all linters
make fmt            format Go + frontend
make fmt-check      verify formatting (CI)
make docker-build   build the container image
make docker-buildx  multi-arch build (needs CAIRN_PLATFORMS)
```

The embedded frontend: `make build` copies `web/dist` into `internal/webui/dist`
and compiles it into the binary. The committed placeholder
`internal/webui/dist/index.html` keeps `go build`/`go test` working on a fresh
clone. **Never commit the build artifacts produced in `internal/webui/dist`** —
they are gitignored; if your working tree shows them modified, restore with
`git checkout -- internal/webui/dist`.

## Testing conventions

- Backend tests follow `<file>_test.go` next to the code, using the standard
  library, `net/http/httptest`, and temporary SQLite files (`t.TempDir()`).
- Frontend tests use Vitest + Testing Library in `web/src/**/*.test.{ts,tsx}`.
- Run the race detector before pushing Go changes.
- Test names describe behavior (`TestHealthDegradedWhenDatabaseDown`), not
  implementation.

## Database

- Migrations are SQL files in `internal/db/migrations/`, named
  `NNNN_description.sql`. Never edit an applied migration; add a new file.
- The server database is created automatically at the configured data dir.
- Never open a library database from more than one process.

## Configuration

See the [README](../README.md) table. All settings are environment variables
under `CAIRN_`.

## Development data

Dev runs create state at `./cairn-data` (from `make dev`). Remove it whenever
experiments leave it in a state you no longer care about:

```sh
rm -rf cairn-data
```

## Making a change

1. Create a branch from `main` (the main branch is always stable).
2. Make small logical commits with conventional messages
   (`feat(storage):`, `test(authz):`, `docs(api):`, `fix(indexer):`).
3. Run `make fmt-check`, `make lint`, and `make test`.
4. Open a pull request. Do not merge it yourself; a human approves merges.