# Face recognition (local, optional)

**Phase:** 15 · **Design doc** · **Base:** Phase 14 (main, merged via PR #15)
**Packages:** `internal/ml` (provider + passes), `internal/librarydb` (schema),
`internal/httpapi` (API), `internal/search` (person filter), `web` (People UI)
**ADR:** ADR-0013

## Context

Cairn's ML layer (Phase 11) is optional, local, dependency-light, and
capability-gated: `CAIRN_ML_ENABLED` is the master switch, similarity arrived
first behind a `Provider` seam, and the Phase 11 note explicitly deferred
face recognition:

> face recognition and embedding model versioning are deferred and can later
> implement the same provider contract.

The product definition (definition of success #19) wants "Use face recognition
if desired", and prompt.md's phase list (§25) requires: detection, embeddings,
clustering, people, naming, search, privacy controls, and local-only
processing. Everything must stay optional, resource-limited, and Raspberry Pi
(ARM64) friendly, and it must never touch original media.

Two hard constraints shape the design:

1. **No learned models to ship.** A real FaceNet/ArcFace embedding requires a
   trained DNN and an ONNX/TFLite runtime; neither is available as a clean
   pure-Go runtime today, and bundling multi-MB model artifacts conflicts with
   "removable, optional, dependency-light". So embeddings are an **appearance
   descriptor** computed locally, behind a provider seam that a learned
   embedder can later implement without changing callers (the same reasoning
   Phase 11 used for similarity).
2. **A workable pure-Go frontal-face detector exists.** `esimov/pigo` is a
   wideley-used, MIT-licensed, zero-dependency (beyond stdlib) LBP-cascade
   detector that cross-compiles to ARM64 and runs comfortably in software on
   personal-hardware workloads. Its `facefinder` cascade (~240 KB, Apache-2.0,
   redistributed with attribution) is embedded in the binary.

## Goals

- Detect faces in images, compute a per-face local descriptor, and organize
  faces into automatically-clustered **people** a user can name.
- Wire people into search (`person=` filter) and give the web UI a People
  section: people grid, per-person media grid, rename, merge, delete, and a
  privacy purge for all derived face data.
- Keep everything opt-in (`CAIRN_ML_ENABLED` + `CAIRN_ML_FACES`), local,
  streaming-safe, and resumable; derive nothing from videos in this phase.
- Never read or modify original files beyond best-effort image decode; all
  face data is derived, regenerable, and purgeable in one call.

## Non-goals

- Identity *verification* or re-identification across pose/view/aging. An
  appearance descriptor is not a learned embedding: it groups frontal faces
  that look alike and will conflate look-alikes and split hard angles. The
  provider seam exists so this can be upgraded later, silently.
- Video face detection/tracking, EXIF person tags, or face-based dedupe.
- Server-level/global people (people are library-scoped; they travel with the
  portable library database, like albums/memories).
- Re-training anything; no model download; no cloud calls.

## Design

### Data model (per-library `library.db`)

```sql
-- Derived, regenerable face observations. Originals are never touched.
CREATE TABLE IF NOT EXISTS faces (
    id          TEXT PRIMARY KEY,              -- uuid
    file_id     TEXT NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,                 -- e.g. "pigo_v1"
    version     INTEGER NOT NULL,              -- detector+embedder algorithm version
    x           INTEGER NOT NULL,              -- face rect, in source-image pixels
    y           INTEGER NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    confidence  REAL NOT NULL,                 -- detector score (0..1)
    descriptor  BLOB NOT NULL,                 -- normalized float32 vector
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS faces_file_idx   ON faces (file_id);
CREATE INDEX IF NOT EXISTS faces_provider_idx ON faces (provider);

-- User-curated people: names and covers survive a face purge. A person is
-- empty when all their faces were purged but the name stays on the shelf.
CREATE TABLE IF NOT EXISTS people (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    cover_face_id  TEXT REFERENCES faces(id) ON DELETE SET NULL,
    cover_file_id  TEXT REFERENCES indexed_files(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS people_name_idx ON people (name COLLATE NOCASE);

-- Assignment of faces to people, either automatic (clustering) or manual.
CREATE TABLE IF NOT EXISTS person_faces (
    person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    face_id     TEXT NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
    assigned_by TEXT NOT NULL CHECK (assigned_by IN ('auto', 'manual')),
    created_at  TEXT NOT NULL,
    PRIMARY KEY (person_id, face_id)
);
CREATE INDEX IF NOT EXISTS person_faces_face_idx ON person_faces (face_id);
```

Semantics of a purge: `DELETE FROM faces` cascades `person_faces`; `people`
rows keep their names (cover references become NULL via `ON DELETE SET NULL`).
A later detection+cluster pass starts over; existing people are reused by
clustering into them (renames and manual assignments are never clobbered).
Manual assignments are persisted by clustering only adding to people, never
moving or clearing existing `assigned_by='manual'` rows.

### Provider seam (`internal/ml/face.go`)

```go
// FaceBox is one detected face within an image (source pixels).
type FaceBox struct {
    X, Y, Width, Height int
    Confidence          float64
}

// FaceProvider local, optional face detection + description. A provider
// identifies its algorithm via Name and Version; bumping Version invalidates
// cached assignments only in the sense that new faces carry the new version.
type FaceProvider interface {
    Name() string
    Version() int
    Detect(img image.Image) ([]FaceBox, error)     // frontal-face boxes
    Describe() string
}

// FaceDescriptor is the derived per-face representation used for clustering.
// Implemented by the appearance embedder in this phase.
type FaceDescriptor = []float32
```

**`PigoFaceProvider`** (default): converts the decoded image to a 1-byte-per-
pixel grayscale buffer, runs `pigo.CascadeParams{MinSize, MaxSize,
ShiftFactor: 0.15, ScaleFactor: 1.1}` + `ClusterDetections`, and returns boxes
with a filterable confidence `Q` (normalized/normalised to 0..1; default
threshold `CAIRN_ML_FACE_MIN_CONFIDENCE`, ~0.05; pigo scores `Q` on an ~0..100
scale, so the default floor is a raw detector score around 5). `MinSize` defaults to
~60 px
(bounded scan cost; tunable via env for Pi). The cascade is embedded via
`//go:embed cascade/facefinder`.

**Appearance embedder** (default): crop the face rect from the color image,
box-inflate by ~10%, resize to 48×48 with `draw.CatmullRom`, luma-convert,
average-pool non-overlapping 3×3 blocks to 16×16 (256 values), z-normalize,
and store the values as `[]float32`.
Clustering compares descriptors by cosine similarity
against a per-cluster mean. This is honest, dependency-free, and stable for
frontal faces; it is explicitly *not* invariant to pose/lighting/expression —
documented as a limitation and behind the seam.

### Passes (`internal/ml/faces.go`)

- `FacePass(ctx, libraryID, root)` — one per library, bounded workers
  (`CAIRN_ML_FACE_WORKERS`, default 2). Selects `present` files that have a
  `media_metadata.media_type='photo'` and no face rows for the current
  provider/version, decodes each image (best-effort skip on decode failure),
  detects, embeds, and upserts faces. Per-file writes so a cancelled pass
  stays resumable (mirrors `Signature.Pass`).
- `ClusterPass(ctx, libraryID, root)` — incremental, deterministic online
  clustering. For every face without a `person_faces` row: compare the
  descriptor to each existing person's running mean (cosine similarity;
  threshold `CAIRN_ML_FACE_THRESHOLD`, default 0.82); assign to the best
  candidate above threshold (update that person's mean), else create a new
  auto person ("Person N") whose cover is that face. Manual rows and existing
  assignments are never mutated. Deterministic because it processes faces in
  `created_at, id` order and means are updated only by assignment order.
- `PurgeFaces(ctx, libraryID, root)` — deletes all faces + assignments, keeps
  people/names (privacy/compliance: derived biometric-ish data removable).
- `FaceStatus`, `People`, and `PersonMedia` read paths for the API.

### REST API (`internal/httpapi/faces.go`)

Everything is library-scoped and mirrors existing capability rules
(`authz.CapRead` for reads incl. face crops, `CapEdit`+ for mutations, admin
for purge). All mutations are audited (existing `audit` service).

| Method & path | Action | Authz |
|---|---|---|
| `GET /libraries/{id}/ml/faces/status` | counts, provider, enabled | read on library |
| `POST /libraries/{id}/ml/faces/pass` | enqueue detection pass | editor |
| `POST /libraries/{id}/ml/faces/cluster` | enqueue clustering pass | editor |
| `POST /libraries/{id}/ml/faces/purge` | privacy purge | admin |
| `GET /libraries/{id}/files/{fileID}/faces` | faces + person in a file | read on file |
| `GET /libraries/{id}/files/{fileID}/faces/{faceID}/image` | cropped face JPEG | read on file |
| `GET /libraries/{id}/people` | people list w/ counts + covers | read on library |
| `POST /libraries/{id}/people` | create named person | editor |
| `PATCH /libraries/{id}/people/{personID}` | rename / set cover | editor |
| `DELETE /libraries/{id}/people/{personID}` | delete person (unassigns faces) | editor |
| `POST /libraries/{id}/people/{personID}/faces/{faceID}` | manual assign | editor |
| `DELETE /libraries/{id}/people/{personID}/faces/{faceID}` | manual unassign | editor |
| `POST /libraries/{id}/people/{keepID}/merge` `{source}` | merge source into keep | editor |

Face image serving: the crop is derived output (like a thumbnail), produced by
re-reading the original through the media service's safe-open path, cropping to
the stored rect, scaling to ≤ 384 px, and encoding as JPEG. It is not stored on
disk. This respects encryption (originals are never encrypted at rest) and does
not bypass authz — the file's `CapRead` is required.

### Search (`internal/search`)

`SearchQuery` gains `PersonID string`. `buildExtraFilters` appends:

```sql
f.id IN (
    SELECT face.file_id FROM faces face
    JOIN person_faces pf ON pf.face_id = face.id
    WHERE pf.person_id = ?
)
```

`HTTP` search gains a `person` query parameter (`parseSearchQuery`). This keeps
person filtering inside the existing filter pipeline (works with text and
browse search, pagination, and the count path unchanged).

### Frontend (`web`)

- Add "People" to the Home nav (a real app-shell nav is out of scope; People is
  a second route alongside `/memories`).
- `PeoplePage`: two states — people grid (avatar crop, name, photo count;
  create/rename inline, delete, purge faces with confirm) and a person detail
  view (media grid built from `search?person=`, with faces of that person and
  manual unassign on hover).
- `api/types.ts` additions (`Person`, `Face`, `FaceStatus`) and `api/client.ts`
  helpers. Face crops render via the authenticated `/faces/{faceID}/image`
  endpoint.

## Config (all opt-in; nothing runs unless the master switch is on)

| Env | Default | Meaning |
|---|---|---|
| `CAIRN_ML_FACES` | `false` | faces capability (requires `CAIRN_ML_ENABLED`) |
| `CAIRN_ML_FACE_WORKERS` | `2` | concurrent files per pass |
| `CAIRN_ML_FACE_MIN_CONFIDENCE` | `0.05` | detector score floor (pigo `Q/100`) |
| `CAIRN_ML_FACE_MIN_SIZE` | `60` | detector minimum window (px) |
| `CAIRN_ML_FACE_THRESHOLD` | `0.82` | clustering cosine similarity |

`ml.Config` and `config.Config` gain the matching fields; `main.go` wires a
`FaceManager` next to the similarity manager and (like similarity) optionally
hooks `idxManager.AfterScan` so a library scan triggers detection when both
flags are on.

## Migration

`librarydb` uses the idempotent canonical schema; the three new tables +
indexes are added to the `schema` const (CREATE TABLE IF NOT EXISTS), the
`SchemaVersion` constant is bumped, and a mirror file
`internal/librarydb/migrations/0009_faces.sql` documents the incremental DDL.
Existing databases gain the tables on next open — no data migration.

## Security & privacy

- Derived face descriptors are *not* credentials but are biometric-adjacent:
  the purge endpoint deletes them entirely (no tombstoning), and they are
  never logged or exported except through authorized face-image/status reads.
- Audit events for create/rename/merge/delete/assign/purge.
- Face image endpoint enforces the *file's* read capability — a face crop can
  never be fetched for a resource the caller cannot read.
- No cloud/network calls anywhere in the pipeline.

## Performance

- Detection is the only expensive step: bounded by `MaxSize`/`MinSize` window
  scan and `ShiftFactor/ScaleFactor`; capped workers keep a small library from
  saturating a Pi. Clustering is O(faces × people) incremental and cheap.
- Descriptors are tiny (256×float32 ≈ 1 KB/face). A 1000-photo pass at ≤4
  faces/photo stores only tens of MB.
- Decode is bounded per file; no full-resolution retention beyond one frame.

## Acceptance tests

- **Fake provider** for deterministic pass/cluster/API tests (a real-face
  fixture is not committed). Pigo provider is exercised on a blank/gradient
  image (expect 0 faces, no error) and on a synthetic dark image.
- `TestFacePassWritesFaces`, `TestClusterPassGroupsAndCreatesPeople`,
  `TestManualAssignSurvivesCluster`, `TestRename/Merge/DeletePerson`,
  `TestPurgeClearsFacesKeepsPeople`, `TestPersonSearchFilter`, and HTTP-level
  tests for read authz on the face image endpoint.
- Regression: full suite green (existing similarity/backups untouched).

## Risks / mitigations

- **Appearance clustering quality** — documented limitation; the provider seam
  allows a learned embedder without API/table changes.
- **pigo on ARM64** — pure stdlib code, cross-compiles; Pi perf is acceptable
  at default `MinSize` because windows are the bounded scan (verified by
  routine perf checks; no hard numbers without hardware).
- **Schema creep** — three additive tables, all derived/user data; purge keeps
  the face footprint erasable and nothing is authoritative.

## Open questions for reviewers

- Should `ML_FACES` default on when `ML_ENABLED` is set (like similarity, whose
  `ML_SIMILARITY` defaults true), or stay an explicit extra opt-in? Proposed:
  **explicit extra opt-in** (similarity stays default-on to preserve Phase 11
  behavior; faces are new and heavier).
- Face cover default when a person has faces but `cover_face_id` is NULL:
  use the cluster's first-assigned face (proposed) rather than a stored file.