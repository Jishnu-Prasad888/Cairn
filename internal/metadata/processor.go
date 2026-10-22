package metadata

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/jobs"
	"github.com/Jishnu-Prasad888/Cairn/internal/media"
)

// KindProcessMedia is the job kind for extracting metadata and generating
// thumbnails for a single media file.
const KindProcessMedia = "process_media"

// Processor runs media processing jobs: EXIF extraction + thumbnail generation.
// It updates the media_metadata table in the per-library database.
type Processor struct {
	logger *slog.Logger
	keys   *crypto.Keys
}

// NewProcessor returns a new Processor. keys seal generated thumbnails when
// at-rest encryption is enabled.
func NewProcessor(logger *slog.Logger, keys *crypto.Keys) *Processor {
	return &Processor{logger: logger, keys: keys}
}

// Handle implements jobs.Handler for KindProcessMedia jobs.
// Expected payload fields:
//
//	library_id string
//	file_id    string
//	rel_path   string
//	root       string  — absolute library root
//	cairn_dir  string  — absolute .cairn directory
func (p *Processor) Handle(ctx context.Context, job *jobs.Job) error {
	fileID, _ := job.Payload["file_id"].(string)
	relPath, _ := job.Payload["rel_path"].(string)
	root, _ := job.Payload["root"].(string)
	cairnDir, _ := job.Payload["cairn_dir"].(string)

	if fileID == "" || relPath == "" || root == "" || cairnDir == "" {
		return fmt.Errorf("process_media job %s missing required payload fields", job.ID)
	}

	absPath := filepath.Join(root, filepath.FromSlash(relPath))

	p.logger.Debug("processing media", "file_id", fileID, "rel_path", relPath)

	// Extract metadata (read-only on the original file).
	info, err := ExtractFromFile(absPath)
	if err != nil {
		// Inaccessible file — not fatal; the file may be missing.
		p.logger.Warn("metadata extraction failed", "file_id", fileID, "error", err)
		return fmt.Errorf("extract metadata: %w", err)
	}

	// A new or changed video on a server without ffmpeg gets its poster from
	// the next client that shows it; drop any poster of the old content.
	if media.DetectMediaType(relPath) == media.MediaTypeVideo && !VideoFramesAvailable() {
		if err := os.Remove(ThumbPath(cairnDir, fileID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			p.logger.Warn("remove stale video poster", "file_id", fileID, "error", err)
		}
	}

	// Generate thumbnail (also read-only; writes only to .cairn/thumbs/).
	hasThumbnail, thumbErr := GenerateThumbnail(absPath, cairnDir, fileID, p.keys)
	if thumbErr != nil {
		p.logger.Warn("thumbnail generation failed", "file_id", fileID, "error", thumbErr)
		// Non-fatal: continue and persist what we have.
	}
	// The small thumbnail and placeholder colour come from the thumbnail just
	// made, so a zoomed-out grid never has to wait for them either.
	var color string
	if hasThumbnail {
		c, err := MakeSmallThumb(cairnDir, fileID, p.keys)
		if err != nil {
			p.logger.Warn("small thumbnail generation failed", "file_id", fileID, "error", err)
		}
		color = c
	} else if err := RemoveSmallThumb(cairnDir, fileID); err != nil {
		p.logger.Warn("remove stale small thumbnail", "file_id", fileID, "error", err)
	}

	// Persist to media_metadata via the db passed in job context.
	if db, ok := ctx.Value(dbKey{}).(*sql.DB); ok {
		if err := persistMetadata(ctx, db, fileID, media.DetectMediaType(relPath), info, hasThumbnail, color); err != nil {
			return fmt.Errorf("persist metadata: %w", err)
		}
	}

	p.logger.Info("media processed",
		"file_id", fileID,
		"width", info.Width,
		"height", info.Height,
		"has_gps", info.HasGPS,
		"has_thumbnail", hasThumbnail,
	)
	return nil
}

// dbKey is the context key for the per-library *sql.DB.
type dbKey struct{}

// WithDB returns a context that carries a per-library database connection
// for use by the Processor handler.
func WithDB(ctx context.Context, db *sql.DB) context.Context {
	return context.WithValue(ctx, dbKey{}, db)
}

// persistMetadata writes extracted info to the media_metadata table.
func persistMetadata(ctx context.Context, db *sql.DB, fileID string, mediaType media.MediaType, info *MediaInfo, hasThumbnail bool, color string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)

	var takenAt *string
	if !info.TakenAt.IsZero() {
		s := info.TakenAt.UTC().Format(time.RFC3339Nano)
		takenAt = &s
	}

	var lat, lon *float64
	if info.HasGPS {
		lat = &info.Latitude
		lon = &info.Longitude
	}

	ht := 0
	if hasThumbnail {
		ht = 1
	}

	_, err := db.ExecContext(ctx, `
		INSERT INTO media_metadata
			(file_id, media_type, width, height, taken_at,
			 camera_make, camera_model, latitude, longitude,
			 has_thumbnail, color, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(file_id) DO UPDATE SET
			media_type    = excluded.media_type,
			width         = excluded.width,
			height        = excluded.height,
			taken_at      = excluded.taken_at,
			camera_make   = excluded.camera_make,
			camera_model  = excluded.camera_model,
			latitude      = excluded.latitude,
			longitude     = excluded.longitude,
			has_thumbnail = excluded.has_thumbnail,
			color         = excluded.color,
			updated_at    = excluded.updated_at`,
		fileID, string(mediaType),
		nullInt(info.Width), nullInt(info.Height),
		takenAt,
		nullStr(info.CameraMake), nullStr(info.CameraModel),
		lat, lon,
		ht, nullStr(color), now,
	)
	return err
}

func nullInt(n int) any {
	if n == 0 {
		return nil
	}
	return n
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
