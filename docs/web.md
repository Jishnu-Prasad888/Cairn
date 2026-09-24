# Web interface

Cairn ships a small single-page web UI served by the server binary. It runs on
Vite + React (TypeScript) in `web/`, talks only to the public REST API
(`/api/v1`, see `docs/api.md`), and degrades to clear error text when a request
fails. All pages share the same design tokens, the `page-header` /
`header-controls` layout, and `data-testid` empty states so they can be tested.

## Pages

| Route        | Page                                      | Source                               |
| ------------ | ----------------------------------------- | ------------------------------------ |
| `/`          | Home — section links                      | `web/src/pages/HomePage.tsx`         |
| `/memories`  | Search and autosave notes                 | `web/src/pages/MemoriesPage.tsx`     |
| `/people`    | Face people: list, rename, merge          | `web/src/pages/PeoplePage.tsx`       |
| `/duplicates`| Duplicate file groups (content hash)      | `web/src/pages/DuplicatesPage.tsx`   |
| `/browse`    | File browser: folders, grid/list, upload, download, photo/video viewer, trash, rename/move/copy | `web/src/pages/BrowserPage.tsx` |
| `/albums`    | Albums: create, delete, add/remove files  | `web/src/pages/AlbumsPage.tsx`       |
| `/tags`      | Tags: create, delete, browse by tag       | `web/src/pages/TagsPage.tsx`         |

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
- **Photo / video viewer** — modal opened by clicking a file: photos use the
  thumbnail endpoint, videos stream from the `{download}` endpoint with inline
  controls. Escape or backdrop click closes.
- **File operations** — from the viewer: Download, Rename, Move, Copy, and Move
  to trash. Rename / move / copy prompt for the new name or destination
  relative path; delete is a soft delete (trash) with a confirmation.
- **Trash** — header toggle showing trashed files with Restore. Permanent
  deletion of copies is out of scope for the UI (only soft delete + restore).

The page consumes only existing endpoints (`folders`, `files`, `search`,
`trash`, `upload`, `thumbnail`, `download`, per-file `rename`/`move`/`copy`/
`delete`/`restore`); the Phase 21 PR added no server surface.

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