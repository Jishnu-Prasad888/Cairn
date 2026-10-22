-- 0009_backup_targets: remote destinations, run reasons, and reference-aware
-- pruning for backups.
--
-- target        — the remote destination's identity (sftp://user@host:22/path,
--                 no secrets); empty for a local directory, whose location is
--                 the destination column itself.
-- reason        — why the run happened: manual, schedule or size.
-- kept_for_refs — a pruned backup whose folder still holds files newer
--                 backups reference (destinations without hard links); it is
--                 removed once nothing points into it.

ALTER TABLE backups ADD COLUMN target TEXT NOT NULL DEFAULT '';
ALTER TABLE backups ADD COLUMN reason TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE backups ADD COLUMN kept_for_refs INTEGER NOT NULL DEFAULT 0;
