package metadata

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
)

const (
	// SmallThumbnailSize is the larger dimension of the small thumbnail: what
	// a zoomed-out grid (or a phone's four-across camera roll) draws, at a
	// quarter of the bytes of the full thumbnail.
	SmallThumbnailSize = 256
	// SmallThumbnailQuality is its JPEG quality; small tiles hide artefacts.
	SmallThumbnailQuality = 76
)

// SmallThumbPath returns where fileID's small thumbnail lives, next to the
// full one.
func SmallThumbPath(cairnDir, fileID string) string {
	return filepath.Join(cairnDir, ThumbsDirName, fileID+".sm.jpg")
}

// SmallThumbModTime returns when fileID's small thumbnail was written. It is
// derived from the full thumbnail, so one older than the full thumbnail (or
// one whose full thumbnail is gone) shows earlier content and is reported as
// missing (an os.ErrNotExist-wrapped error), to be made again.
func SmallThumbModTime(cairnDir, fileID string) (time.Time, error) {
	small, err := renditionModTime(SmallThumbPath(cairnDir, fileID))
	if err != nil {
		return time.Time{}, err
	}
	large, err := ThumbModTime(cairnDir, fileID)
	if err != nil {
		return time.Time{}, err
	}
	if small.Before(large) {
		return time.Time{}, fmt.Errorf("small thumbnail predates thumbnail: %w", os.ErrNotExist)
	}
	return small, nil
}

// ReadSmallThumb reads and decrypts fileID's small thumbnail.
func ReadSmallThumb(cairnDir, fileID string, keys *crypto.Keys) ([]byte, time.Time, error) {
	return readRendition(SmallThumbPath(cairnDir, fileID), keys)
}

// MakeSmallThumb derives fileID's small thumbnail from its full thumbnail —
// a 400px decode, not the original's — and returns the picture's average
// colour as "#rrggbb", which the grid paints while the image loads. The full
// thumbnail must exist.
func MakeSmallThumb(cairnDir, fileID string, keys *crypto.Keys) (string, error) {
	data, _, err := ReadThumb(cairnDir, fileID, keys)
	if err != nil {
		return "", err
	}
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("decode thumbnail: %w", err)
	}
	small := resizeToFit(img, SmallThumbnailSize)
	if err := writeRendition(small, SmallThumbPath(cairnDir, fileID), SmallThumbnailQuality, keys); err != nil {
		return "", err
	}
	return AverageColor(small), nil
}

// GenerateSmallThumbnail has the shape of GenerateThumbnail for the on-demand
// path: it makes (or remakes, when the original changed since) the full
// thumbnail if needed, then the small one from it.
func GenerateSmallThumbnail(srcPath, cairnDir, fileID string, keys *crypto.Keys) (bool, error) {
	large, err := ThumbModTime(cairnDir, fileID)
	outdated := false
	if err == nil {
		if info, statErr := os.Stat(srcPath); statErr == nil {
			mod := info.ModTime()
			outdated = large.Before(mod) && !mod.After(time.Now())
		}
	}
	if err != nil || outdated {
		ok, genErr := GenerateThumbnail(srcPath, cairnDir, fileID, keys)
		if genErr != nil || !ok {
			return ok, genErr
		}
	}
	if _, err := MakeSmallThumb(cairnDir, fileID, keys); err != nil {
		return false, err
	}
	return true, nil
}

// RemoveSmallThumb deletes fileID's small thumbnail, if there is one.
func RemoveSmallThumb(cairnDir, fileID string) error {
	err := os.Remove(SmallThumbPath(cairnDir, fileID))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// AverageColor is img's mean colour as "#rrggbb", sampling every other pixel
// in each direction (plenty for a placeholder, and a quarter of the work).
func AverageColor(img image.Image) string {
	b := img.Bounds()
	var r, g, bl, n uint64
	if rgba, ok := img.(*image.RGBA); ok {
		for y := b.Min.Y; y < b.Max.Y; y += 2 {
			for x := b.Min.X; x < b.Max.X; x += 2 {
				i := rgba.PixOffset(x, y)
				p := rgba.Pix[i : i+3]
				r += uint64(p[0])
				g += uint64(p[1])
				bl += uint64(p[2])
				n++
			}
		}
	} else {
		for y := b.Min.Y; y < b.Max.Y; y += 2 {
			for x := b.Min.X; x < b.Max.X; x += 2 {
				cr, cg, cb, _ := img.At(x, y).RGBA()
				r += uint64(cr >> 8)
				g += uint64(cg >> 8)
				bl += uint64(cb >> 8)
				n++
			}
		}
	}
	if n == 0 {
		return ""
	}
	return fmt.Sprintf("#%02x%02x%02x", r/n, g/n, bl/n)
}

// StoreColor records fileID's placeholder colour. A file whose metadata has
// not been processed yet has no row; the processor writes it then.
func StoreColor(ctx context.Context, db *sql.DB, fileID, color string) error {
	if color == "" {
		return nil
	}
	_, err := db.ExecContext(ctx,
		`UPDATE media_metadata SET color = ? WHERE file_id = ?`, color, fileID)
	return err
}
