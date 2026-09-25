# Web interface

Cairn ships a small single-page web UI served by the server binary. It runs on
Vite + React (TypeScript) in `web/`, talks only to the public REST API
(`/api/v1`, see `docs/api.md`), and degrades to clear error text when a request
fails. All pages share the same design tokens, the `page-header` /
`header-controls` layout, and `data-testid` empty states so they can be tested.

## Pages

| Route        | Page                                      | Source                               |
| ------------ | ----------------------------------------- | ------------------------------------ |
| `/setup`    | First run: create the first (admin) account | `web/src/pages/SetupPage.tsx`       |
| `/login`    | Sign in                                   | `web/src/pages/LoginPage.tsx`        |
| `/`          | Home — section links                      | `web/src/pages/HomePage.tsx`         |
| `/memories`  | Search and autosave notes                 | `web/src/pages/MemoriesPage.tsx`     |
| `/people`    | Face people: list, rename, merge          | `web/src/pages/PeoplePage.tsx`       |
| `/duplicates`| Duplicate file groups (content hash)      | `web/src/pages/DuplicatesPage.tsx`   |
| `/browse`    | File browser: folders, grid/list, upload, download, photo/video viewer, trash, rename/move/copy | `web/src/pages/BrowserPage.tsx` |
| `/albums`    | Albums: create, delete, add/remove files  | `web/src/pages/AlbumsPage.tsx`       |
| `/tags`      | Tags: create, delete, browse by tag       | `web/src/pages/TagsPage.tsx`         |
| `/settings`  | Account, appearance, accounts (admin)    | `web/src/pages/SettingsPage.tsx`     |
| `/403`       | Access denied                             | `web/src/pages/ForbiddenPage.tsx`    |

## Authentication and sessions

The web UI is session-based: the browser holds only the opaque `cairn_session`
cookie and every request relies on it. `AuthProvider` (`web/src/auth/`) reads
the public `GET /auth/status` on load, so the app can decide between the app
itself, the sign-in page, and first-run setup before rendering anything.

- **First run (`/setup`, also reachable as `/signup`)** — Cairn has no accounts
  until somebody creates one, and the first account is always the
  administrator. The page posts to `/auth/bootstrap` and says so plainly, since
  this is the one time the account being created gets full rights (libraries,
  other accounts, backups). It validates the same rules the server enforces —
  `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$` for the username, 8–1024 bytes for the
  password — and asks for the password twice. The form is only offered while
  the server reports `bootstrap_required`; once an account exists the same page
  says that an administrator creates accounts and offers a link back to
  `/login`, so it can never be used to add accounts behind the administrator's
  back.
- **Sign in (`/login`)** — username/password form posting to `/auth/login`, and
  a failed attempt shows the server's error text verbatim. A **Create an
  account** button sits under the form on every visit, linking to `/setup`, so
  the route is always discoverable. The line above it is first-run copy ("First
  time on this server?") while `bootstrap_required` is set, and the normal
  "Need an account?" afterwards. An anonymous visitor lands here by default; a
  visitor to a server with no accounts who opens an app URL is sent straight to
  `/setup` by the gate.
- **Gate (`RequireAuth`)** — every other route sits behind the gate: a splash
  while the session is being resolved, then either the app or a redirect to
  `/setup`/`/login` that remembers the requested path.
- **Sign out** — available from the sidebar footer and from Settings. It posts
  to `/auth/logout` and drops the local principal even if the request fails.
- **401 vs 403** — the API client broadcasts both failures on `window`
  (`cairn:unauthorized`, `cairn:forbidden`) so no page has to special-case them.
  A 401 re-reads the auth state, which returns the visitor to `/login`; a 403
  routes to `/403`, carrying the server's own reason. The access-denied page
  renders on its own (no sidebar) because several endpoints — notably
  `GET /libraries` — are administrator-only, so a member account legitimately
  meets 403 while browsing and a rail of dead links would only confuse.
- **Settings (`/settings`)** — account summary and sign-out, appearance
  (system/light/dark, persisted in `localStorage` and applied to
  `<html data-theme>` using the palettes already defined in `tokens.css`), and
  for administrators the account list with create-user and session-revocation
  controls from `/users`.

The gate, client, and pages are covered by `RequireAuth.test.tsx`,
`SetupPage.test.tsx`, `LoginPage.test.tsx`, `SettingsPage.test.tsx`,
`ForbiddenPage.test.tsx`, and `App.test.tsx` (routing).

## File browser (`/browse`)

The browser is the Phase 21 deliverable and the primary way to manage library
files from the web UI.

- **Library selector** — header control that switches libraries; the current
  folder, search, trash panel, and viewer reset on switch.
- **Navigation** — folder cards with per-folder file counts; breadcrumbs back to
  the library root. Folder state is `rel_path`-based.
- **Grid / list views** — toggle in the toolbar. Photos render via the
  `{thumbnail}` endpoint; other media fall back to a type glyph.
- **Search** — replaces the folder listing with `{search}` results while a query
  is typed; clearing restores navigation.
- **Upload** — multipart `POST .../files/upload` with the file and its computed
  destination path (current folder + filename). Shows an "Uploading…" state and
  reloads the listing on success.
- **Photo / video viewer** — modal opened by clicking a file; it is centered and
  capped at 1080px (the viewport width minus the page gutters on small screens).
  Photos use the thumbnail endpoint, videos stream from the `{download}` endpoint
  with inline controls. Escape or backdrop click closes.
- **Markdown note** — a note editor sits directly under the image/video with
  Write/Preview tabs, rendered Markdown, and debounced autosave (via the
  per-file `note` endpoints). The note persists server-side per library.
- **File operations** — from the viewer: Download, Favorite, Rename, Move, Copy,
  and Move to trash. Rename / move / copy prompt for the new name or
  destination relative path; delete is a soft delete (trash) with a
  confirmation.
- **Details** — when the extractor has populated metadata, a Details panel lists
  dimensions, duration, camera, capture time, and a map link for GPS
  coordinates.
- **Trash** — header toggle showing trashed files with Restore. Permanent
  deletion of copies is out of scope for the UI (only soft delete + restore).

The page consumes existing endpoints (`folders`, `files`, `search`,
`trash`, `upload`, `thumbnail`, `download`, per-file `rename`/`move`/`copy`/
`delete`/`restore`, plus viewer `metadata`, `favorite`, and `note`); the Phase 21
PR added no server surface.

## Organization (`/albums`, `/tags`)

The organization pages are the Phase 22 deliverable and close the gap between
the organization API (Phase 5) and a browsable web interface. Both are
library-scoped and use the shared `ViewerModal` and `FileGrid` components.

- **Albums (`/albums`)** — album cards with a create prompt and delete
  confirmation. Opening an album shows its file grid with a per-file remove
  button and an **Add files** picker: type to search the library, tick results,
  and add them to the album. Membership POSTs are idempotent; adding never
  duplicates media (albums are logical collections).
- **Tags (`/tags`)** — tag cards with a create prompt and delete confirmation
  (removal propagates to every file). Opening a tag lists every file carrying
  it (via `{search}?tag=…`) with a per-file remove button.
- **Tag management in the viewer** — the shared photo/video viewer now carries a
  **Tags** section: current tags with a per-tag remove button and an "Add tag"
  input that auto-completes existing tags and creates new ones on the fly
  (create-then-attach). This works from `/browse`, `/albums`, and `/tags`
  alike.

Shared UI lives in `web/src/components/` (`ViewerModal.tsx`, `FileGrid.tsx`,
`media.ts`, `views.css`); the pages reuse it rather than duplicating viewer
code. The Phase 22 PR added no server surface — only existing `albums`, `tags`,
`search`, and per-file tag endpoints are consumed.

## Adding a page

Follow the existing pattern: a `page-header` with an `h1` and `header-controls`
(Home link, library selector when library-scoped), a `.muted` loading state, an
`.error-text` alert, `data-testid` on empty states, and a matching
`page-name.test.tsx` that mocks `fetch` against the documented API envelope.
Register the route in `web/src/App.tsx` and link it from
`web/src/pages/HomePage.tsx`.