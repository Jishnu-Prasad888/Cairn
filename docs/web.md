# Web interface

Cairn ships a single-page web UI served by the server binary. It runs on
Vite + React (TypeScript) in `web/`, talks only to the public REST API
(`/api/v1`, see `docs/api.md`), and degrades to clear error text when a request
fails.

The app is a session-based shell around that API. `AuthProvider` resolves the
session once, `LibrariesProvider` loads the libraries the caller can read once
and shares them, and every page renders through `AppShell` against those two
facts. Shared pieces (`Dialog`, `States`, `FileOperations`, `ViewerModal`,
`MediaGrid`, `LibraryPicker`, `RefPicker`) are the reason a page is a page and
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
| `/`                | Home                                      | Newest photos, people, albums, memories — no counters                              |
| `/photos`, `/videos` | Timelines                               | Every photo or video, newest first, grouped by day                                  |
| `/files`           | Files                                     | Folders, breadcrumbs, grid or list, upload, new folder                              |
| `/search`          | Search results                            | `?q=`, `?type=`, `?person=`, `?album=`, `?tag=`                                     |
| `/albums`, `/albums/:id` | Albums                              | Cover grid; one album with rename, cover, add/remove                                |
| `/memories`, `/memories/:id` | Memories                         | Journal cards; Markdown editor with write/split/preview                              |
| `/people`          | People                                    | Round face portraits, naming, merging, face tools menu                               |
| `/tags`            | Tags                                      | `tags` CRUD and the per-tag file grid                                                |
| `/favorites`       | Favorites                                 | `/favorites`; per-user                                                               |
| `/trash`           | Trash                                     | Restore, delete forever, empty trash — bulk                                          |
| `/shared`          | Sharing                                   | `shares` CRUD, capabilities, expiry, revoke                                          |
| `/duplicates`, `/libraries`, `/permissions`, `/ml`, `/backups` | Manage        | Upkeep surfaces, grouped under "Manage" in the sidebar                                |
| `/settings`        | Settings                                  | Account, appearance, library, accounts (admin), advanced, about                      |

`/media` and `/browse` redirect to `/files` / `/search`. Every filter, folder,
query, and the open photo (`?view=<id>`) is in the address bar.

`PhotosPage`, `VideosPage`, `FilesPage`, and `SearchPage` are four small
configurations of a single `MediaPage` — one grid, one set of filters, one
viewer — rather than four copies of it. The look and the component inventory
are documented in `docs/design-system.md`.

## App shell and navigation

`components/app-shell/AppShell.tsx` composes the `Sidebar`, `TopBar`,
`MobileNav`, the upload tray, and the shortcuts sheet around every signed-in
page. Navigation lives in `navigation.ts` so the sidebar, the phone's bottom
bar, and the "More" drawer never disagree: Home, Photos, Videos, Albums,
People, Memories, Files, Favorites, Shared, Trash; a collapsible **Manage**
group (Tags, Duplicates, Libraries, Permissions, Machine learning, Backups);
Settings and the library switcher at the foot.

- **Search** (`SearchBox`) is the prominent control in the top bar. `/` focuses
  it; it suggests as you type — search everything, in Photos, in Videos, and
  matching people, albums, and tags from the real library — and offers recent
  searches (stored per browser). Submitting goes to `/search?q=`.
- **Library switcher** shows the selected library with its state: offline, an
  indexing count that climbs while a scan runs (polled every few seconds, only
  while the tab is visible), or its item count.
- **Narrow screens**: below 900px the sidebar is a drawer opened from "More" in
  the bottom bar (Home, Photos, Albums, Search, More); below 600px search is a
  tab rather than a top-bar box.
- Global shortcuts: `/` (search) and `?` (shortcut sheet), ignored while typing
  or while a dialog or the viewer owns the keyboard.

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

`MediaPage.tsx` backs Photos, Videos, Files, and Search through one
`useFileListing` hook (`components/media/`):

- **Photos / Videos** are timelines: the whole library, `recursive`, newest
  first, grouped under day headings. **Files** is the file manager: folders and
  breadcrumbs (each folder a history entry), grid or list (remembered), an
  in-folder search, new folder, and drag-to-move onto a folder or breadcrumb.
- A plain listing uses `GET /files` (sort order, folders); a query, a
  person/album/tag, or a date/size filter uses `GET /search`.
- **Grid** (`MediaGrid`) is virtualized: rows are laid out from pure arithmetic
  (`layout.ts`) and only those near the viewport are mounted, so 100k loaded
  items still render a few dozen tiles. Pages load by cursor as the end
  approaches (IntersectionObserver), with a "Load more" fallback. Tiles are
  stable squares, the image fades in over a quiet placeholder, and keyboard
  focus uses a single roving tab stop.
- **Selection** (`useSelection`, `SelectionToolbar`, `useMediaActions`): click,
  Shift range, Ctrl/Cmd toggle, Space, Ctrl+A, Escape, long press on touch. The
  bar offers Download, Add to album, Favorite, Move to trash (with a
  confirmation), plus page-specific actions. A right-click or the row's "more"
  opens the same actions as a menu.
- **Upload** goes through `UploadProvider`: drop files anywhere on the page or
  use Upload; the compact tray shows per-file progress with cancel and retry
  while the person keeps browsing.

## Viewer

`components/ViewerModal.tsx` is a full-window dark lightbox. The photo loads
progressively (the grid thumbnail first, the original over it; a format the
browser cannot decode falls back to the preview). Video streams — the download
route serves `Range` requests — and is never held in memory.

- Controls float over scrims and fade after a few seconds of stillness; any
  movement or key brings them back. Back-arrow, zoom, favorite, share,
  download, details, trash, and a "More" menu (rename, move, copy, album,
  slideshow, fullscreen, hide controls).
- Keyboard: `←` `→`, `+` `-` `0`, `Space` (video), `F`, `I`/`T`, `S`, `H`,
  `Esc`. On touch: swipe to page, pull down to close.
- **Details panel** (`viewer/DetailsPanel`) shows only what exists: when,
  name/size/dimensions/duration, camera, location, folder. Tabs for Tags,
  Albums, People, Memories, Similar, Share each fetch only when opened. It is
  a side panel on desktop and a bottom sheet on phones.
- The open photo is `?view=<id>` (`FileOperations.useViewerParam`): opening it
  pushes a history entry so Back closes the viewer, paging replaces it, and a
  link or reload reopens the same photo.
- Mutations are delegated to the page through `onRequestAction`, which routes
  into `useFileOperations`.

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
- `setup.ts` — jest-dom, clean `localStorage` before and after every test (grid/
  list, viewer panel, and recent searches are per-browser preferences), plus a
  5s `asyncUtilTimeout`. The default 1s budget is
  real time, and real time is a flake generator once two dozen files are
  rendering in parallel.

The frontend suite (one file per page plus the shell, grid, menu, toast,
upload, and search components), each targeting behaviour rather
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
3. Add it to `PRIMARY_NAV` or `MANAGE_NAV` in
   `components/app-shell/navigation.ts` so it is reachable, and from the
   Settings lists if it belongs there.
4. Write `web/src/pages/YourPage.test.tsx` against the harness.
5. Add a row to the table above and run the gate.
