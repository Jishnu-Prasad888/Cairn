# Local ML

Planned (dedicated phases). Cairn's ML features are **completely optional**:

- The application is fully functional with ML disabled.
- ML runs locally; no external ML service is required and nothing is transmitted
  (face data never leaves the device).
- Capabilities are individually configurable:

```text
ML enabled: false

Face recognition: false
Similarity: false
Embeddings: false
```

- All ML work is asynchronous, resource-limited, and removable (derived data can
  be deleted; regenerating is safe because originals are never touched).
- ML integrates with the background job system (concurrency limits, progress,
  retries).

Architecture: an ML abstraction with optional providers behind it, so no hard
dependency exists at build or runtime.