# Contributing

Thanks for your interest in Cairn.

## Code of conduct

Be kind and constructive. Cairn is personal software with strong opinions about
privacy and ownership of your data; disagreements are fine, dismissiveness is
not.

## Repo essentials

- `main` is always stable. Work on feature branches.
- Every PR must run `make fmt-check`, `make lint`, and `make test` cleanly, and
  the CI workflow (which adds the race detector, golangci-lint, and the frontend
  pipeline).
- Keep the API contract (`docs/openapi.yaml`) in sync with the Go handlers in
  the same PR.
- Go: follow the style in the existing packages — thin handlers, injected
  deps, `database/sql`, explicit SQL, tests next to code.
- Frontend: TypeScript strict, tokens from `src/styles/tokens.css`, Testing
  Library + Vitest.
- Commit messages: conventional (`feat(storage):`, `fix(indexer):`,
  `docs(api):`, `test(authz):`, `build(docker):`). Small, logical commits.

## What to work on

Start with [docs/roadmap.md](roadmap.md) phases in dependency order. Look for
issues labeled `good first issue`. If a change will alter interfaces or
structure, propose an ADR first ([docs/adr](adr)).

## Submitting

1. Fork / branch.
2. Make your change with focused commits.
3. Run the full quality gate.
4. Open the PR; a human approves and merges. Do not self-merge.

When your PR touches the frontend embedding or build steps, verify the
`internal/webui/dist` placeholder story still holds (see
[development.md](development.md)).