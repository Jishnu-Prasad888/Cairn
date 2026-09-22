# Backups

Planned. Requirements:

- Destination selection and scheduling (frequency).
- Incremental backups.
- Compression that avoids recompressing already-compressed formats (JPEG/MP4).
- Optional encryption.
- Retention policies.
- Verification (restore-a-sample checks).
- Backups of the server database and each library's Casp metadata databases.
- Restoration of metadata/database.
- Status and logs.
- A warning when the backup destination is on the same physical device as the
  source.

Backups always include each library's `.cairn/` metadata directory so that a
restored Cairn knows everything it knew.