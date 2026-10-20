package metadata

import (
	"fmt"
	"image"
	"image/draw"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/rwcarlsen/goexif/exif"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/safeimage"
)

const (
	// PreviewSize is the maximum dimension (width or height) of the
	// screen-sized rendition the viewer shows in place of the original.
	PreviewSize = 2048
	// PreviewQuality is the JPEG quality for previews (0-100).
	PreviewQuality = 85
	// PreviewsDirName is the previews subdirectory name inside .cairn/.
	PreviewsDirName = "previews"
)

// PreviewPath returns the absolute path for the preview of a file identified
// by fileID, given the library's .cairn directory.
func PreviewPath(cairnDir, fileID string) string {
	return filepath.Join(cairnDir, PreviewsDirName, fileID+".jpg")
}

// GeneratePreview writes a screen-sized JPEG of the photo at srcPath to
// PreviewPath(cairnDir, fileID): at most PreviewSize on its longer side, with
// the EXIF orientation applied (the encoded JPEG carries no EXIF, so the
// browser cannot apply it). A photo the size of a screen or less is far
// cheaper to send and decode than a camera original, which is what makes the
// viewer quick.
//
// It returns (false, nil), having decoded nothing but the header, when the
// original serves as well: it already fits and needs no turning, or it is a
// GIF (which may be animated). It returns (false, nil) too for a file this
// server cannot decode; the browser may still show the original.
func GeneratePreview(srcPath, cairnDir, fileID string, keys *crypto.Keys) (bool, error) {
	src, err := os.Open(srcPath)
	if err != nil {
		return false, fmt.Errorf("open source for preview: %w", err)
	}
	defer func() { _ = src.Close() }()

	cfg, format, err := safeimage.DecodeConfig(src)
	if err != nil || format == "gif" {
		return false, nil
	}
	orientation := 1
	if format == "jpeg" {
		orientation = readOrientation(src)
	}
	if cfg.Width <= PreviewSize && cfg.Height <= PreviewSize && orientation == 1 {
		return false, nil
	}

	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return false, fmt.Errorf("rewind source for preview: %w", err)
	}
	img, _, err := safeimage.Decode(src)
	if err != nil {
		return false, nil
	}
	img = orient(resizeToFit(img, PreviewSize), orientation)
	if err := writeRendition(img, PreviewPath(cairnDir, fileID), PreviewQuality, keys); err != nil {
		return false, err
	}
	return true, nil
}

// PreviewModTime returns when fileID's preview was last written. A missing
// preview returns an os.ErrNotExist-wrapped error.
func PreviewModTime(cairnDir, fileID string) (time.Time, error) {
	return renditionModTime(PreviewPath(cairnDir, fileID))
}

// ReadPreview reads and decrypts the preview for fileID, returning the JPEG
// bytes and the file's modification time.
func ReadPreview(cairnDir, fileID string, keys *crypto.Keys) ([]byte, time.Time, error) {
	return readRendition(PreviewPath(cairnDir, fileID), keys)
}

// readOrientation returns the EXIF orientation (1–8) of the image r holds,
// or 1 when it has none.
func readOrientation(r io.ReadSeeker) int {
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return 1
	}
	x, err := exif.Decode(r)
	if err != nil {
		return 1
	}
	tag, err := x.Get(exif.Orientation)
	if err != nil {
		return 1
	}
	v, err := tag.Int(0)
	if err != nil || v < 1 || v > 8 {
		return 1
	}
	return v
}

// orient returns img turned and mirrored as EXIF orientation o asks, so it
// reads upright.
func orient(img image.Image, o int) image.Image {
	if o <= 1 || o > 8 {
		return img
	}
	b := img.Bounds()
	src, ok := img.(*image.RGBA)
	if !ok || b.Min != (image.Point{}) {
		src = image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
		draw.Draw(src, src.Bounds(), img, b.Min, draw.Src)
	}
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			var sx, sy int
			switch o {
			case 2: // mirrored
				sx, sy = w-1-x, y
			case 3: // turned 180°
				sx, sy = w-1-x, h-1-y
			case 4: // mirrored vertically
				sx, sy = x, h-1-y
			case 5: // transposed
				sx, sy = y, x
			case 6: // needs a quarter turn clockwise
				sx, sy = y, h-1-x
			case 7: // transversed
				sx, sy = w-1-y, h-1-x
			case 8: // needs a quarter turn anticlockwise
				sx, sy = w-1-y, x
			}
			copy(dst.Pix[dst.PixOffset(x, y):][:4], src.Pix[src.PixOffset(sx, sy):][:4])
		}
	}
	return dst
}
