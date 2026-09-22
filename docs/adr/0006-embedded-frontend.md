# 0006 — Embed the frontend into a single binary

- Status: accepted
- Date: 2026-09-22

## Context

Production must ship as a single native executable and a single container image
for ARM64 and AMD64, with no runtime network dependency (fonts, assets, UI all
bundled). Development, meanwhile, benefits from a separate hot-reloading
frontend dev server.

## Decision

The built React frontend is embedded into the Go binary with `go:embed` and
served by the server as a single-page application (SPA fallback to `index.html`,
immutable caching for hashed `/assets/*`). `internal/webui` owns this; a
committed placeholder `internal/webui/dist/index.html` keeps `go build`/`go test`
working on a fresh clone, and `make build` overwrites it from `web/dist` before
compiling. In development, the Vite dev server proxies `/api` to the Go backend,
so developers never need the embedded copy.

## Consequences

- One artifact to deploy and one image to pull; simplest possible self-hosting.
- SPA caching semantics prevent stale client bundles in production.
- Build tooling must copy the frontend output before release builds; documented
  in `docs/development.md`.