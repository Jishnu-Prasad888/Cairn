# Troubleshooting

## Server won't start / errors on boot

- Check the bind address: `CAIRN_HTTP_ADDR` must be reachable and the port free.
- Check `CAIRN_DATA_DIR` is writable by the running user. Default location:
  `$XDG_DATA_HOME/cairn` or `~/.local/share/cairn`.
- Set `CAIRN_LOG_LEVEL=debug` and reproduce; logs include the error's request ID.

## BI-native issue: opening the frontend shows the placeholder page

`internal/webui/dist/index.html` is a committed placeholder so `go build`/`go test`
work on a fresh clone. It is overwritten by `make build` (or by the Docker image
build) with the real frontend output.

- If you ran `go build ./cmd/cairn` from a fresh clone instead of `make build`,
  you get the placeholder. Use `make build` and re-run; then `git status` will
  show `internal/webui/dist` modified — restore with
  `git checkout -- internal/webui/dist` (those files are gitignored artifacts).

## Frontend changed but the embedded app still shows the old UI

Rebuild: `make build` (or `make web-build` for the dev flow, then restart the
Go server). During frontend development use the Vite dev server (`make web-dev`)
which hot-reloads and proxies `/api` to the Go backend on :8715.

## Health endpoint times out

`GET /api/v1/health` pings the server database with a short timeout. If it
returns `"status": "degraded"`, the database check failed but the process is
alive — look at `CAIRN_DATA_DIR` permissions and disk health.

## API returns 404 for a route that should exist

Unknown `/api/...` routes return the JSON error envelope with
`code: NOT_FOUND`. If you typed `GET /health` instead of `GET /api/v1/health`,
you get a 404 from the SPA fallback (serves the app) — that is expected. Use the
full `/api/v1/...` prefix.

## Unknown method on an existing API route

The router returns a JSON `405 METHOD_NOT_ALLOWED` with the same error envelope,
rather than serving the SPA. This is intentional; see [api.md](api.md).

## Port already in use

```sh
lsof -i :8715          # find the process
# or
sudo ss -ltnp | grep 8715
```

## Docker: container exits immediately

- Ensure `-v cairn-data:/data` persists data; the image expects `/data` to be
  writable by the `cairn` user.
- Ensure `CAIRN_HTTP_ADDR=:8715` is set if you expose the port as written in
  [docker.md](docker.md); the default listens on `127.0.0.1` inside the
  container which a mapped `-p` port cannot reach.
- `docker logs cairn` shows startup errors with request IDs.