package backups

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/library"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
)

// Triggers start a backup when enough new data has arrived since the last
// one, without waiting for the schedule. Either threshold on its own is
// enough; zero disables it.
type Triggers struct {
	// SingleFileBytes fires when any one new or changed file is at least
	// this large (a long video, a big RAW).
	SingleFileBytes int64 `json:"single_file_bytes"`
	// TotalBytes fires when new and changed files add up to at least this
	// much, however many files that takes.
	TotalBytes int64 `json:"total_bytes"`
}

// Normalize rejects negative thresholds.
func (t Triggers) Normalize() (Triggers, error) {
	if t.SingleFileBytes < 0 || t.TotalBytes < 0 {
		return t, errors.New("trigger sizes must not be negative")
	}
	return t, nil
}

// Enabled reports whether any threshold is set.
func (t Triggers) Enabled() bool { return t.SingleFileBytes > 0 || t.TotalBytes > 0 }

// Pending summarises what is new since the last completed backup.
type Pending struct {
	Since        time.Time `json:"since"`
	Files        int64     `json:"files"`
	Bytes        int64     `json:"bytes"`
	LargestBytes int64     `json:"largest_bytes"`
}

// Exceeds reports which threshold, if any, the pending data crosses.
func (t Triggers) Exceeds(p Pending) (string, bool) {
	if t.SingleFileBytes > 0 && p.LargestBytes >= t.SingleFileBytes {
		return "a new file is larger than the single-file trigger", true
	}
	if t.TotalBytes > 0 && p.Bytes >= t.TotalBytes {
		return "new files add up to more than the total-size trigger", true
	}
	return "", false
}

// pendingSince counts files the indexer has seen appear or change since
// `since` across every online library. It reads the library databases rather
// than walking the disks, so it is cheap enough to run after every scan; the
// flip side is that a file counts once the indexer has seen it.
//
// Times are stored as RFC3339Nano strings, whose fractional seconds do not
// sort lexically, so the comparison is on the whole-second prefix and is
// inclusive: a file from the very second a backup started counts as new.
func pendingSince(ctx context.Context, libs []library.Library, since time.Time) (Pending, error) {
	p := Pending{Since: since}
	cut := ""
	if !since.IsZero() {
		cut = since.UTC().Format("2006-01-02T15:04:05")
	}
	for _, lib := range libs {
		if lib.Status != library.StatusOnline {
			continue
		}
		db, release, err := librarydb.Acquire(filepath.Join(lib.Root, ".cairn"))
		if err != nil {
			continue
		}
		var files, bytes, largest int64
		err = db.QueryRowContext(ctx, `
			SELECT COUNT(*), COALESCE(SUM(size_bytes), 0), COALESCE(MAX(size_bytes), 0)
			FROM indexed_files
			WHERE status = 'present'
			  AND (substr(first_seen_at, 1, 19) >= ? OR substr(mod_time, 1, 19) >= ?)`,
			cut, cut).Scan(&files, &bytes, &largest)
		release()
		if err != nil {
			return p, err
		}
		p.Files += files
		p.Bytes += bytes
		p.LargestBytes = max(p.LargestBytes, largest)
	}
	return p, nil
}
