# Web interface

Cairn ships a single-page web UI served by the server binary. It runs on
Vite + React (TypeScript) in `web/`, talks only to the public REST API
(`/api/v1`, see `docs/api.md`), and degrades to clear error text when a request
fails.

The app is a session-based shell around that API. `AuthProvider` resolves the
session once, `LibrariesProvider` loads the libraries the caller can read once
and shares them, and every page renders through `AppShell` against those two
facts. Shared pieces (`Dialog`, `States`, `FileOperations`, `ViewerModal`,
`FileGrid`, `LibraryPicker`, `RefPicker`) are the reason a page is a page and
not a copy of the same fetch/cancel/error logic.

## Pages

Every route in `web/src/App.tsx`, and the endpoints each one is the only
surface for.

| Route              | Page                                      | What it covers                                                                   |
| ------------------ | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `/setup`, `/signup` | First run: create the first (admin) account | `/auth/bootstrap`                                                             |
| `/login`           | Sign in                                   | `/auth/login`                                                                     |
| `/s/:token`        | Public share (no session)                 | `/shares/{token}`, its files, and per-file download                                |
| `/403`             | Access denied                             | Standalone — a permission failure replaces the whole UI                            |
| `/`                | Home                                      | Recent media, quick counts, and the section links                                   |
| `/photos`          | Photos                                    | Photo listing and `search?type=photo`                                               |
| `/videos`          | Videos                                    | Video listing and `search?type=video`                                               |
| `/files`           | Files                                     | The untyped listing, with folders                                                  |
| `/browse`          | Browse                                    | Flat and untyped; where the top-bar search lands                                    |
| `/memories`, `/memories/:memoryId` | Memories                  | notebook editor (text + image blocks, live Markdown, layouts, slideshow, media picker, image editor, Preview); code in `src/memories/`, see [memories.md](memories.md) |
| `/albums`          | Albums                                    | `albums` CRUD and membership                                                       |
| `/people`          | People                                    | `people`, face clusters, naming, merging, and the unassigned-face purge            |
| `/tags`            | Tags                                      | `tags` CRUD and the per-tag file listing                                           |
| `/favorites`       | Favorites                                 | `/favorites`; per-user, so only you see yours                                       |
| `/trash`           | Trash                                     | `trash`, restore, and the permanent delete                                         |
| `/shared`          | Sharing                                   | `shares` CRUD, capabilities, expiry, revoke, and the link itself                   |
| `/duplicates`      | Duplicate groups                          | `files/duplicates`; keep one, delete the rest                                        |
| `/libraries`       | Libraries                                 | Register, reconnect, re-index, and unregister storage                              |
| `/permissions`     | Permissions                               | Per-library grants, plus a typed user id when the admin user list is not readable  |
| `/ml`              | Machine learning                          | Similarity and face passes, the signature and face purges, and their availability  |
| `/backups`         | Backups                                   | Run, verify, and restore; administrator-only                                        |
| `/settings`        | Settings                                  | Account, appearance, the Organize links, accounts (admin), the Server upkeep links  |

`PhotosPage`, `VideosPage`, `FilesPage`, and `BrowsePage` are four small
configurations of a single `MediaPage` — one grid, one search, one set of
filters, one viewer — rather than four copies of it.

## App shell and navigation

`AppShell` (`web/src/components/AppShell.tsx`) renders the left navigation, the
top bar, and the account footer. Two groups, in the order the product spec
lists them: the browsing sections (Home, Photos, Videos, Files, Memories,
Albums, People, Tags, Shared, Favorites, Trash, Settings) and **Upkeep**
(Duplicates, Libraries, Permissions, Machine learning, Backups). `/browse` is
deliberately not linked — a "Browse" entry next to Photos, Videos, and Files is
four ways to the same place — but the top-bar search navigates there, and the
query stays in the address bar so it is linkable and re-applies on reload.

Below the icon rail's breakpoint the sidebar becomes a drawer: a menu button
with `aria-expanded`, a dismissable backdrop, and Escape that closes it and
returns focus to the button that opened it.

## Library selection

`LibrariesProvider` fetches `GET /libraries` once and remembers the selection in
`localStorage` under `cairn.library`. `useLibraryGate` turns that into one of
four `kind`s — `loading`, `error`, `empty`, `ready` — so a page never has to
decide what "no libraries" means versus "no albums". A caller with no grants
gets an **empty list, not a 403** (see `docs/permissions.md`); only an
administrator can register a library, so the empty state says so.

## Loading, errors, and empty states

`useResource` and `useLibraryResource` (`web/src/api/resources.ts`) are the only
two ways a page loads anything. Each tags its result with the key it was
fetched for and derives `loading`/`data`/`error` during render, so a stale
response can never be shown against a new library, there is no `setState` in an
effect body, and in-flight requests are cancelled. Errors are reduced to a
message string, so anything that needs the HTTP *status* — a 404 meaning "this
build has no such route" versus a 503 meaning "the provider is switched off" —
has to decide at the fetch boundary (`MLPage` does).

`States.tsx` holds the shared renders: `PageHeader`, `LoadingState`,
`ErrorState` (with a retry that re-runs the request), `EmptyState`,
`NoLibrariesState`, `LibraryOfflineNotice`, `LibraryStatusBadge`,
`LibrarySelect`.

## Dialogs

`components/Dialog.tsx` replaces every `window.prompt` and `window.confirm` in
the app with `Dialog`, `ConfirmDialog`, and `PromptDialog`: real
`role="dialog"` markup, a focus trap, focus restored to the invoking element on
close, Escape to dismiss, a backdrop that only closes on an intentional click,
and a `role="alert"` for a failure that happened inside the dialog. A dialog
that fails keeps its error and stays open, so the action can be retried.

## Media browser

`MediaPage.tsx` backs Photos, Videos, Files, and Browse:

- **Library selector and folders** — folder cards with file counts and
  breadcrumb navigation over `rel_path`. Photos, Videos, and Files browse
  folders; Browse is deliberately flat, because that is the view a search
  result lands in.
- **Search** — server-side, so `?q=` from the top bar lands in the same
  component and a shareable URL reproduces it. A query switches the page from
  `listFiles` to `searchFiles`; the two are the same response shape.
- **Filters** — a date range and a size range, sent as query parameters, with
  a "Clear filters" that actually re-queries instead of only clearing the
  inputs. The `type` filter is fixed per page by the page's configuration
  rather than by a control, because a Photos page offering a Videos filter is
  a contradiction.
- **Sort** — date, name, size, and type, in both directions, in one control so
  the direction is visible rather than implied by a second click.
- **Pagination** — cursor-based, "Load more" rather than numbered pages,
  because the API is cursor-based and a page number would be a lie.
- **Upload** — multipart `POST .../files/upload` with the computed destination
  path, an "Uploading…" state, and a reload on success.

## Viewer

`components/ViewerModal.tsx` is the app's most-used surface. It owns the image
and video stage and the surrounding chrome, and nothing else: mutations are
delegated to the page through `onRequestAction`, which routes into
`useFileOperations` (`components/FileOperations.tsx`) so the dialogs exist once
rather than once per page.

- **Zoom** — `+`/`-`, the buttons, or Ctrl/Cmd with the wheel, through
  100–800%, and `0` to fit. Zooming resizes the element rather than painting a
  `transform` over it, because a transform does not enlarge the scrollable area
  and the corners of a scaled photo would be unreachable.
- **Fullscreen** — button or `f`; escape leaves fullscreen before it leaves the
  viewer.
- **Previous / next** — arrow keys or buttons, across the siblings the page
  passed in, so paging follows whatever collection the viewer was opened from.
- **Slideshow** — `s` or the button; advances through the siblings and **stops
  at the end** rather than looping behind the user's back. The button is
  `aria-pressed`, so its state is not something you have to see to know.
- **Panels** — Details (dimensions, duration, camera, capture time, GPS map
  link), Tags, People, Memories, Similar, and Share, as a tablist toggled with
  `t` that only fetches the tab you are looking at. A section the server
  cannot answer says so instead of showing an error.
- **Markdown note** — a per-file editor with Write/Preview and debounced
  autosave.
- **Actions** — Download, Favorite, Rename, Move, Copy, Move to trash. Every
  one of them is a dialog. `DELETE /files/{id}` acts on `body.path`, not the
  id, so the path is what gets sent.
- **Focus** — the dialog takes focus on open and hands it back to the tile that
  opened it on close, and Tab stays inside it. Keys are ignored while a text
  field has focus, so `t` in a note does not toggle the panel.

## Trash

`/trash` lists soft-deleted files with Restore and Delete forever. The
permanent delete is the only irreversible action in the product, so it is not
wired to the same button as restore: it names the file, says the bytes are
removed from disk and that this cannot be undone, and the viewer on that page
offers a permanent delete rather than a second soft delete, which would be a
no-op.

## Accessibility

- `window.prompt` and `window.confirm` are gone; see **Dialogs** above.
- Focus trapping lives in `src/lib/focusTrap.ts` and is shared by the dialogs
  and the viewer, because `aria-modal="true"` is a promise — a screen reader in
  focus mode will walk straight past the end of the dialog and start announcing
  the page behind it unless Tab wraps.
- The viewer is a labelled dialog; arrow keys page, `Escape` closes, and the
  slideshow toggle is an `aria-pressed` button.
- The media grid is a list of buttons with real names, not clickable `div`s.
- Every loading, empty, offline, and error state is text, not a spinner alone.
- The library picker, file picker, and reference picker are labelled form
  controls. `RefPicker` exists because a memory has to point at a file, a tag,
  an album, or a person, and doing that four times by hand is how the four
  copies drift apart.
- `prefers-reduced-motion` and the light/dark palette live in
  `styles/global.css` and `styles/tokens.css`; the theme choice is persisted
  in `localStorage` and applied to `<html data-theme>`, so it is applied before
  the first paint rather than flashing.

## Tests

`web/src/test/` holds the scaffolding and the shared harness:

- `harness.tsx` — `mockApi(rules, { user, libraries, authenticated })` with
  per-route handlers that fall through to a 404 in the API's own error
  envelope; `admin`/`member`, `libraryFixture`, `fileFixture`, `json`,
  `noContent`, `apiError`, `called`, `bodyOf`, and `renderPage`, which wraps a
  page in the router, the auth provider, and the shared library list exactly as
  the app does.
- `Providers.tsx` — the same provider stack on its own, for a component test
  that has to declare its own routes.
- `setup.ts` — jest-dom plus a 5s `asyncUtilTimeout`. The default 1s budget is
  real time, and real time is a flake generator once two dozen files are
  rendering in parallel.

257 tests across 24 files, one suite per page, each targeting behaviour rather
than markup: that a member is not sent a request that can only 403, that a
locked share asks for its password before anything else, that a 503 from the
face provider is reported as unavailable rather than as a failure, that
clearing the filters re-queries, that zooming resizes the image so its edges
can be scrolled to, that Tab wraps inside the viewer rather than reaching the
grid behind it, that the permanent delete names its target. Gate: `npm run
typecheck && npm run lint && npm test && npm run build && npm run format:check`,
plus `go test ./...`.

## Adding a page

1. Write `web/src/pages/YourPage.tsx`. Load with `useResource` or
   `useLibraryResource`; render the shared `States`; ask for names and
   confirmations through `components/Dialog.tsx`; hand the viewer's mutations
   to `useFileOperations` rather than fetching them again.
2. Register the route in `web/src/App.tsx`, inside `<AppShell>`.
3. Add it to `NAV_ITEMS` or `ADMIN_ITEMS` in `AppShell.tsx` so it is reachable,
   and from `HomePage.tsx` and the Settings Organize/Server upkeep lists if it
   belongs there.
4. Write `web/src/pages/YourPage.test.tsx` against the harness.
5. Add a row to the table above and run the gate.
