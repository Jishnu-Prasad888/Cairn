# Cairn design system

Cairn is a personal media library: smooth pebbles, handmade clay, warm paper,
and the owner's own photographs. The interface stays quiet so the photographs
carry the color. This document is the contract for how the web UI looks and
behaves; the tokens it names live in `web/src/styles/tokens.css`.

## Principles

- **Photos first.** Thumbnails are not cards. Chrome appears only when it is
  useful: hover reveals quick actions, a selection reveals the action bar, the
  viewer shows controls that fade after a few seconds of stillness.
- **Warm, not decorative.** Rounded geometry, gentle borders, short shadows.
  The clay feeling comes from one subtle top highlight on raised controls
  (`--shadow-clay`), not from inflated surfaces.
- **Calm states.** Empty, loading, error, offline, and not-allowed states are
  all designed, written for people, and never show a path, a stack trace, or an
  id.
- **Fast on a Raspberry Pi.** No blur-heavy effects, no constant animation,
  virtualized grids, route-level code splitting, thumbnails in grids and
  originals only in the viewer.

## Color

Only the Cairn palette is used; components consume semantic tokens, never hex.
Light and dark are both defined in `tokens.css`; "system" follows
`prefers-color-scheme`. Dark is `#29221f`, never black.

| Token                                            | Use                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `--color-background`, `-surface`, `-surface-elevated` | page, quiet panels, raised controls and menus                         |
| `--color-text-primary / -secondary / -muted`     | body; supporting text; placeholders and icons only                       |
| `--color-border`, `--color-border-subtle`        | control outlines; hairlines between rows                                 |
| `--color-primary` (+ `-hover`)                   | brand accent, icons, focus                                               |
| `--color-primary-strong`                         | filled primary buttons (the primary deepened so light text reads at 4.5:1) |
| `--color-primary-ink`                            | primary as _text_ (links, dates) at 4.5:1                                |
| `--color-success/-warning/-danger` and `*-ink`   | status; the `-ink` forms are for text on tinted fills                    |
| `--color-selection`, `--color-accent-soft`       | selected tiles; the active navigation fill                               |
| `--color-fill-subtle/-hover/-active`             | quiet fills derived from the palette                                     |

`--color-text-muted` (#A59488 on the light background) is below 4.5:1, so it is
reserved for placeholders and decorative icons. Informative text uses
`--color-text-secondary`.

The **viewer** always uses the dark palette (`--viewer-*`) because a photo is
judged against a dark surround, whatever the app theme.

## Typography

- **Handlee** (`--font-brand`) — the wordmark, the Home greeting, branded
  empty-state headings. Nothing dense.
- **Fira Sans** (`--font-ui`) — everything functional. Both fonts are bundled
  in `src/fonts`; nothing is fetched at runtime.
- Scale: `--font-size-xs … 3xl` (12 / 13 / 14 / 16 / 20 / 24 / 30). Hierarchy
  comes from size, weight (400/500/600), and spacing rather than extra color.

## Space, radius, elevation, motion

- Spacing is a 4px grid, `--space-1 … 8`.
- Radii by component type: media tiles `--radius-media` (4px), chips and small
  controls `--radius-sm`, buttons and inputs `--radius-md`, panels `--radius-lg`,
  dialogs `--radius-xl`, avatars and icon buttons `--radius-pill`.
- Borders first; shadows are low and short (`--shadow-1 … 3`) and used only on
  elevated surfaces (menus, dialogs, the selection bar).
- Interaction transitions are 120–220ms (`--duration-fast/base/slow`) with
  `--ease-standard`. `prefers-reduced-motion` collapses all of them.

## Layers

One z-index scale, documented in `tokens.css`: base 0 · raised 1 · sticky 100 ·
navigation 200 · dropdown 300 · drawer 400 · viewer 500 · modal 600 · popover
650 · toast 700. Dialogs sit above the viewer because the viewer opens them.

## Breakpoints

| Name     | Range        | Layout                                             |
| -------- | ------------ | -------------------------------------------------- |
| compact  | < 600px      | bottom navigation, 3-column grid, sheet dialogs    |
| medium   | 600–899px    | bottom navigation, drawer, larger tiles            |
| expanded | 900–1199px   | persistent sidebar                                 |
| wide     | ≥ 1200px     | persistent sidebar, wide grid                      |

CSS uses only `max-width: 599px`, `899px`, and `1199px` (plus
`(pointer: coarse)` / `(hover: hover)`); `src/lib/breakpoints.ts` mirrors them
for the few decisions made in script. Content is capped at
`--content-max-width` for forms and settings; photo grids use the full width.

## Components

Reusable pieces, by folder under `web/src/components`:

- `app-shell/` — `AppShell`, `Sidebar`, `MobileNav`, `TopBar`, `SearchBox`
  (combobox with suggestions and recent searches), `AccountMenu`,
  `LibrarySwitcher` (online/offline and indexing status), `ShortcutsDialog`.
- `media/` — `MediaGrid` (virtualized, date-grouped, roving-tabindex keyboard
  navigation), `MediaTile`, `SelectionToolbar`, `useSelection`,
  `useFileListing`, `useMediaActions`, `useFavorites`, and `layout.ts` (the
  pure geometry that makes virtualization testable).
- `viewer/` + `ViewerModal` — the photo/video viewer and its panels.
- `files/` — `Breadcrumbs`, `FolderGrid`, `FileTable`, `FilterPanel`.
- `albums/` — `AlbumCard`, `AlbumPickerDialog`, `AddFilesDialog`.
- `upload/` — `UploadProvider` (queue, 2 at a time, progress, cancel, retry)
  and `UploadTray`.
- `ui/` — `Icon` (the one icon set), `Menu` (dropdown and context menu),
  `Toast`.
- `States.tsx` — `PageHeader`, `LoadingState`, `ListSkeleton`, `ErrorState`,
  `EmptyState`, `NoLibrariesState`, `LibraryOfflineNotice`,
  `PermissionDeniedState`.
- `Dialog.tsx` — `Dialog`, `ConfirmDialog`, `PromptDialog`.

Shared control classes (`styles/controls.css`): `.button` (secondary),
`.primary-button`, `.danger-button`, `.ghost-button`, `.icon-button`,
`.link-button`, `.chip`, `.segmented`, `.status-badge`, `.progress`,
`.skeleton`, and the field styles for inputs and selects. Buttons are 40px
tall (44px on coarse pointers); every icon-only control carries an accessible
name.

## Interaction patterns

- **Selection.** A circle appears on hover/focus (always on touch after a long
  press). Click toggles once a selection exists, Shift extends a range,
  Ctrl/Cmd toggles, Space selects the focused tile, Ctrl+A selects all, Escape
  clears. The top bar is replaced by an action bar with the count.
- **Toast vs dialog vs panel.** Toasts confirm ("Added to album"); dialogs
  confirm only destructive or consequential actions ("Move 14 items to
  trash?"); the viewer's details live in a side panel.
- **Menus** anchor to their trigger or pointer, stay inside the viewport,
  support arrow/Home/End/type-ahead, close on Escape or an outside press, and
  put destructive items last after a separator.
- **URL state.** Folder, query, type, open photo, album, and memory are in the
  address bar, so Back, reload, and sharing a link behave.

## Keyboard shortcuts

`/` search · `?` shortcuts · `Esc` close · arrows move in grids and the viewer ·
`Space` select / play · `Ctrl+A` select all · `Delete` trash the selection ·
viewer: `+` `-` `0` zoom, `F` fullscreen, `I` details, `S` slideshow, `H` hide
controls.

## Accessibility

Audited with axe (WCAG 2.0/2.1 A and AA plus best-practice rules) on every
page in light and dark, and the viewer: no violations. Dialogs trap focus and
restore it; menus and the search combobox follow the ARIA patterns; tabs use
the tablist pattern; the grid keeps one tab stop. Touch targets are 44px on
coarse pointers.
