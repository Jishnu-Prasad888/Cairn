---
title: Local face recognition via detection + appearance descriptors
status: accepted
date: 2026
related:
  - 0009-local-ml-provider-abstraction
supersedes: []
---

# ADR-0013 — Local face recognition via detection + appearance descriptors

## Status

Accepted (Phase 15).

## Context

Phase 11 (ADR-0009) built Cairn's optional local ML layer around a provider
seam and shipped dependency-free perceptual similarity, explicitly deferring
face recognition to "the same provider contract". Face recognition in the
product definition means: detect faces, group them into nameable people,
search by person, purge derived data, keep everything local/optional/ARM64.

The obstacle to a learned embedder (FaceNet/ArcFace-style) is that Cairn has
no ML runtime and ships no model artifacts: the project is a small pure-Go
binary, and bundling an ONNX/TFLite engine plus multi-MB models contradicts
its "optional, removable, dependency-light, Raspberry Pi" constraints. Most
of the value of a face feature (finding and naming the recurring people in a
personal photo library) can still be delivered locally:

- a **pure-Go detection** step that reliably finds frontal faces
  (`esimov/pigo`, MIT, LBP cascade, stdlib-only at runtime), and
- a **local appearance descriptor** per face that clusters same-look frontal
  faces into provisional people the user names.

## Decision

We will ship face recognition in two layers, both behind the Phase 11-style
provider seam:

1. **Detector provider** (`FaceProvider.Detect`): `PigoFaceProvider` embeds
   the `facefinder` cascade (redistributed from pigo, Apache-2.0, attribution
   kept in `internal/ml/cascade/`) and returns face boxes + confidence.
2. **Embedder** (part of the same provider/version): an **appearance
   descriptor** — face crop → 16×16 z-normalized grayscale vector — compared
   by cosine similarity for incremental online clustering of faces into
   `people`. This is *not* a biometric verification system: it groups faces
   that look alike and does **not** generalize across pose/lighting/aging. The
   seam deliberately lets a learned embedder replace it later (bump `Version`,
   re-run a pass, keep API/schema untouched).

People are library-scoped rows in the per-library database (they travel with
the portable library, like albums/memories). Manual assignments (`assigned_by
= 'manual'`) and renames are never clobbered by clustering; a privacy purge
deletes all derived faces/assignments while keeping user-entered names.
Face crops are served as derived images (like thumbnails) only through the
owning file's read capability.

## Consequences

- **Pros:** fully local, opt-in (`CAIRN_ML_ENABLED` + `CAIRN_ML_FACES`),
  dependency-light (one MIT pure-Go lib + a 240 KB cascade), ARM64-safe,
  no model/licensing burden, eraseable derived data, schema/API stable when a
  learned embedder lands.
- **Cons:** clustering fidelity is bounded by the appearance descriptor —
  look-alikes may group, hard angles may not. Users must set expectations
  ("people" ≠ verified identity). Detection misses strong profiles.
- **Future option:** re-implement `FaceProvider` with an ONNX-on-ARM runtime
  when one is available cleanly; per-face `provider`/`version` columns make
  the switch transparent.

## Alternatives considered

- **Bundling a learned model (ONNX/TFLite):** rejected — no clean pure-Go
  runtime, multi-MB artifacts, violates the lightweight/removable ethos.
- **External ML service:** rejected — privacy (faces are sensitive).
- **Compiled C cascades / libopencv:** rejected — breaks the pure-Go,
  cross-compiling, single-binary model.
- **Skipping embeddings (boxes only, no people):** rejected — naming and
  person search are the product value.