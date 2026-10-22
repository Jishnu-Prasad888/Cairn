package metadata

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/Jishnu-Prasad888/Cairn/internal/jobs"
)

// RenditionsBatch is how many files one renditions job brings forward. Each
// is a 400px decode and a 256px encode, a few milliseconds, so a batch keeps
// the job short and the worker free for scans and new files in between.
const RenditionsBatch = 200

// PendingRenditions reports whether any file with a thumbnail still lacks its
// small thumbnail and placeholder colour (a library processed by an older
// build).
func PendingRenditions(ctx context.Context, db *sql.DB) (bool, error) {
	var one int
	err := db.QueryRowContext(ctx, `
		SELECT 1 FROM media_metadata m JOIN indexed_files f ON f.id = m.file_id
		 WHERE m.has_thumbnail = 1 AND m.color IS NULL AND f.status = 'present'
		 LIMIT 1`).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check pending renditions: %w", err)
	}
	return true, nil
}

// HandleRenditions implements jobs.Handler for KindRenditions: it makes the
// small thumbnail and colour for up to RenditionsBatch files and reports, via
// more, whether others remain. A file whose thumbnail cannot be read gets an
// empty colour so it is not retried forever; a new or changed file is
// processed afresh by process_media anyway.
func (p *Processor) HandleRenditions(ctx context.Context, job *jobs.Job) (more bool, err error) {
	cairnDir, _ := job.Payload["cairn_dir"].(string)
	db, ok := ctx.Value(dbKey{}).(*sql.DB)
	if cairnDir == "" || !ok {
		return false, fmt.Errorf("renditions job %s missing cairn_dir or database", job.ID)
	}
	rows, err := db.QueryContext(ctx, `
		SELECT m.file_id FROM media_metadata m JOIN indexed_files f ON f.id = m.file_id
		 WHERE m.has_thumbnail = 1 AND m.color IS NULL AND f.status = 'present'
		 LIMIT ?`, RenditionsBatch)
	if err != nil {
		return false, fmt.Errorf("list pending renditions: %w", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return false, err
		}
		ids = append(ids, id)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return false, err
	}

	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		color, err := MakeSmallThumb(cairnDir, id, p.keys)
		if err != nil {
			p.logger.Debug("small thumbnail not made", "file_id", id, "error", err)
			color = ""
		}
		if _, err := db.ExecContext(ctx,
			`UPDATE media_metadata SET color = ? WHERE file_id = ?`, color, id); err != nil {
			return false, fmt.Errorf("store colour: %w", err)
		}
	}
	if len(ids) > 0 {
		p.logger.Info("small thumbnails made", "count", len(ids))
	}
	return len(ids) == RenditionsBatch, nil
}
