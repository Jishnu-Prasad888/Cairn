package metadata

import (
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"

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
// ThumbPath(cairnDir, fileID). The original file is never modified.
// Returns (true, nil) when the thumbnail was written, (false, nil) when the
// file is not a supported image type.
func GenerateThumbnail(srcPath, cairnDir, fileID string) (bool, error) {
	src, err := os.Open(srcPath)
	if err != nil {
		return false, fmt.Errorf("open source for thumbnail: %w", err)
	}
	defer func() { _ = src.Close() }()

	img, _, err := image.Decode(src)
	if err != nil {
		// Not a supported image — skip silently (video, audio, docs, etc.).
		return false, nil
	}

	thumb := resizeToFit(img, ThumbnailSize)

	thumbsDir := filepath.Join(cairnDir, ThumbsDirName)
	if err := os.MkdirAll(thumbsDir, 0o755); err != nil {
		return false, fmt.Errorf("create thumbs dir: %w", err)
	}

	destPath := ThumbPath(cairnDir, fileID)
	tmp := destPath + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return false, fmt.Errorf("create thumbnail temp: %w", err)
	}

	if err := jpeg.Encode(out, thumb, &jpeg.Options{Quality: ThumbnailQuality}); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return false, fmt.Errorf("encode thumbnail: %w", err)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return false, fmt.Errorf("close thumbnail: %w", err)
	}
	if err := os.Rename(tmp, destPath); err != nil {
		_ = os.Remove(tmp)
		return false, fmt.Errorf("commit thumbnail: %w", err)
	}
	return true, nil
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
