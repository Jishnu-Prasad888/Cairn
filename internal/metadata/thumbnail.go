package metadata

import (
	"bytes"
	"context"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/media"
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
// ThumbPath(cairnDir, fileID). Photos are decoded directly, except AVIF and
// HEIC, and photos past safeimage's pixel cap, which go through ffmpeg; videos use their first frame, extracted with
// ffmpeg too. The original file is never modified; when keys are enabled the
// on-disk thumbnail is sealed with the at-rest key. Returns (true, nil) when the thumbnail was written,
// (false, nil) when the file has no thumbnail this server can make.
func GenerateThumbnail(srcPath, cairnDir, fileID string, keys *crypto.Keys) (bool, error) {
	if media.DetectMediaType(srcPath) == media.MediaTypeVideo {
		if !VideoFramesAvailable() {
			return false, nil
		}
		frame, err := extractVideoFrame(context.Background(), srcPath)
		if err != nil {
			// ffmpeg cannot decode this file (corrupt, unrecognised codec,
			// not actually a video, etc.) — skip silently rather than
			// treating it as a server error.
			return false, nil
		}
		if err := writeThumb(frame, cairnDir, fileID, keys); err != nil {
			return false, err
		}
		return true, nil
	}

	if stillFramesAvailable(srcPath) {
		img, err := extractStill(context.Background(), srcPath)
		if err != nil {
			return false, nil // not decodable after all; skip like any other
		}
		if err := writeThumb(img, cairnDir, fileID, keys); err != nil {
			return false, err
		}
		return true, nil
	}

	src, err := os.Open(srcPath)
	if err != nil {
		return false, fmt.Errorf("open source for thumbnail: %w", err)
	}
	defer func() { _ = src.Close() }()

	img, err := decodePhoto(src, srcPath, ThumbnailSize)
	if err != nil {
		// Not a supported image (or too large even for ffmpeg) — skip
		// silently (audio, docs, etc.).
		return false, nil
	}
	if err := writeThumb(img, cairnDir, fileID, keys); err != nil {
		return false, err
	}
	return true, nil
}

// writeThumb resizes img, encodes it as JPEG and commits it atomically to
// ThumbPath(cairnDir, fileID), sealed when keys are enabled.
func writeThumb(img image.Image, cairnDir, fileID string, keys *crypto.Keys) error {
	return writeRendition(resizeToFit(img, ThumbnailSize), ThumbPath(cairnDir, fileID), ThumbnailQuality, keys)
}

// writeRendition encodes img as JPEG and commits it atomically to destPath,
// creating its directory and sealing it when keys are enabled.
func writeRendition(img image.Image, destPath string, quality int, keys *crypto.Keys) error {
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return fmt.Errorf("create rendition dir: %w", err)
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return fmt.Errorf("encode rendition: %w", err)
	}
	data := keys.Seal(buf.Bytes())

	// A temp file of its own: the background worker and a request can make
	// the same rendition at once, and with a shared name one renamed the
	// other's file away mid-write.
	tmp, err := os.CreateTemp(filepath.Dir(destPath), filepath.Base(destPath)+".*.tmp")
	if err != nil {
		return fmt.Errorf("write rendition: %w", err)
	}
	_, err = tmp.Write(data)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("write rendition: %w", err)
	}
	if err := os.Rename(tmp.Name(), destPath); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("commit rendition: %w", err)
	}
	return nil
}

// ThumbModTime returns when fileID's thumbnail was last written. A missing
// thumbnail returns an os.ErrNotExist-wrapped error.
func ThumbModTime(cairnDir, fileID string) (time.Time, error) {
	return renditionModTime(ThumbPath(cairnDir, fileID))
}

// ReadThumb reads and decrypts the thumbnail for fileID, returning the JPEG
// bytes and the file's modification time. A missing thumbnail returns an
// os.ErrNotExist-wrapped error; legacy plaintext thumbnails are returned
// unchanged even when keys are enabled.
func ReadThumb(cairnDir, fileID string, keys *crypto.Keys) ([]byte, time.Time, error) {
	return readRendition(ThumbPath(cairnDir, fileID), keys)
}

func renditionModTime(path string) (time.Time, error) {
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}, fmt.Errorf("stat rendition: %w", err)
	}
	return info.ModTime(), nil
}

func readRendition(path string, keys *crypto.Keys) ([]byte, time.Time, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("stat rendition: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, info.ModTime(), fmt.Errorf("read rendition: %w", err)
	}
	plain, err := keys.Open(data)
	if err != nil {
		return nil, info.ModTime(), fmt.Errorf("decrypt rendition: %w", err)
	}
	return plain, info.ModTime(), nil
}

// resizeToFit returns a new image scaled so the larger dimension equals
// maxDim, preserving aspect ratio. If the image is already smaller than
// maxDim it is returned unchanged.
//
// A large reduction is done in two steps: a box filter shrinks the image by
// a whole factor (averaging every source pixel, so there is no aliasing),
// then a bilinear pass covers the rest. BiLinear alone over a full-size photo is
// several times slower and costs more than the decode.
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

	// Under a 2× reduction the cheap approximation samples densely enough.
	var scaler draw.Scaler = draw.ApproxBiLinear
	if k := min(w/newW, h/newH); k >= 2 {
		if small := boxShrink(src, k); small != nil {
			src, b = small, small.Bounds()
		} else {
			scaler = draw.BiLinear
		}
	}

	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	scaler.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
	return dst
}
