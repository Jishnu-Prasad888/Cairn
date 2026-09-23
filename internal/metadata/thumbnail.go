package metadata

import (
	"bytes"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/safeimage"
	"golang.org/x/image/draw"
)

const (
	// ThumbnailSize is the maximum dimension (width or height) for thumbnails.
	ThumbnailSize = 400
	// ThumbnailQuality is the JPEG quality for generated thumbnails (0-100).
	ThumbnailQuality = 82
	// ThumbsDirName is the thumbnails subdirectory name inside .cairn/.
	ThumbsDirName = "thumbs"
)

// ThumbPath returns the absolute path for the thumbnail of a file identified
// by fileID, given the library's .cairn directory.
func ThumbPath(cairnDir, fileID string) string {
	return filepath.Join(cairnDir, ThumbsDirName, fileID+".jpg")
}

// GenerateThumbnail creates a JPEG thumbnail from srcPath and writes it to
// ThumbPath(cairnDir, fileID). The original file is never modified; when keys
// are enabled the on-disk thumbnail is sealed with the at-rest key. Returns
// (true, nil) when the thumbnail was written, (false, nil) when the file is
// not a supported image type.
func GenerateThumbnail(srcPath, cairnDir, fileID string, keys *crypto.Keys) (bool, error) {
	src, err := os.Open(srcPath)
	if err != nil {
		return false, fmt.Errorf("open source for thumbnail: %w", err)
	}
	defer func() { _ = src.Close() }()

	img, _, err := safeimage.Decode(src)
	if err != nil {
		// Not a supported image (or exceeds safety limits) — skip silently
		// (video, audio, docs, etc.).
		return false, nil
	}

	thumb := resizeToFit(img, ThumbnailSize)

	thumbsDir := filepath.Join(cairnDir, ThumbsDirName)
	if err := os.MkdirAll(thumbsDir, 0o755); err != nil {
		return false, fmt.Errorf("create thumbs dir: %w", err)
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: ThumbnailQuality}); err != nil {
		return false, fmt.Errorf("encode thumbnail: %w", err)
	}
	data := keys.Seal(buf.Bytes())

	destPath := ThumbPath(cairnDir, fileID)
	tmp := destPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return false, fmt.Errorf("write thumbnail: %w", err)
	}
	if err := os.Rename(tmp, destPath); err != nil {
		_ = os.Remove(tmp)
		return false, fmt.Errorf("commit thumbnail: %w", err)
	}
	return true, nil
}

// ReadThumb reads and decrypts the thumbnail for fileID, returning the JPEG
// bytes and the file's modification time. A missing thumbnail returns an
// os.ErrNotExist-wrapped error; legacy plaintext thumbnails are returned
// unchanged even when keys are enabled.
func ReadThumb(cairnDir, fileID string, keys *crypto.Keys) ([]byte, time.Time, error) {
	path := ThumbPath(cairnDir, fileID)
	info, err := os.Stat(path)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("stat thumbnail: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, info.ModTime(), fmt.Errorf("read thumbnail: %w", err)
	}
	plain, err := keys.Open(data)
	if err != nil {
		return nil, info.ModTime(), fmt.Errorf("decrypt thumbnail: %w", err)
	}
	return plain, info.ModTime(), nil
}

// resizeToFit returns a new image scaled so the larger dimension equals
// maxDim, preserving aspect ratio. Uses high-quality BiLinear resampling.
// If the image is already smaller than maxDim it is returned unchanged.
func resizeToFit(src image.Image, maxDim int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w == 0 || h == 0 {
		return src
	}
	if w <= maxDim && h <= maxDim {
		return src
	}

	var newW, newH int
	if w >= h {
		newW = maxDim
		newH = int(float64(h) * float64(maxDim) / float64(w))
	} else {
		newH = maxDim
		newW = int(float64(w) * float64(maxDim) / float64(h))
	}
	if newW < 1 {
		newW = 1
	}
	if newH < 1 {
		newH = 1
	}

	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	draw.BiLinear.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
	return dst
}
