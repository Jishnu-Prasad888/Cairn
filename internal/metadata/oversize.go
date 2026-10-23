package metadata

import (
	"context"
	"errors"
	"fmt"
	"image"
	"io"
	"os"

	"github.com/Jishnu-Prasad888/Cairn/internal/safeimage"
)

// maxOversizePixels bounds the frame ffmpeg holds while it decodes a photo
// past safeimage.MaxPixels: after a JPEG's reduced-resolution decode, so a
// 200-megapixel phone shot passes, but not a PNG claiming 30k×30k.
const maxOversizePixels = 2 * safeimage.MaxPixels

// errOversize is returned for a photo too large even for the ffmpeg path.
var errOversize = errors.New("photo too large to decode")

// decodePhoto decodes the photo src holds (read from srcPath) for a rendition
// at most maxDim on its longer side. A photo within safeimage's limits is
// decoded in Go; one past them (a 108 MP phone camera's 78-megapixel JPEG,
// say) goes to ffmpeg, which scales it down as it decodes.
func decodePhoto(src io.ReadSeeker, srcPath string, maxDim int) (image.Image, error) {
	img, _, err := safeimage.Decode(src)
	if errors.Is(err, safeimage.ErrTooLarge) {
		return decodeOversized(srcPath, maxDim)
	}
	return img, err
}

// decodeOversized decodes the photo at path with ffmpeg, scaled to fit
// within maxDim×maxDim. The EXIF orientation is not applied, as with a photo
// decoded in Go, so callers turn both alike.
func decodeOversized(path string, maxDim int) (image.Image, error) {
	bin := ffmpegPath()
	if bin == "" {
		return nil, ErrNoVideoDecoder
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open oversized photo: %w", err)
	}
	cfg, format, err := image.DecodeConfig(f) // the header only; no pixels
	_ = f.Close()
	if err != nil {
		return nil, fmt.Errorf("read oversized photo header: %w", err)
	}
	if cfg.Width > safeimage.MaxDimension || cfg.Height > safeimage.MaxDimension {
		return nil, fmt.Errorf("%w: %dx%d", errOversize, cfg.Width, cfg.Height)
	}

	// A JPEG decodes at 1/2, 1/4 or 1/8 scale straight from its DCT blocks:
	// faster, and a fraction of the memory. Take the smallest that still
	// covers maxDim.
	lowres := 0
	if format == "jpeg" {
		for lowres < 3 && max(cfg.Width, cfg.Height)>>(lowres+1) >= maxDim {
			lowres++
		}
	}
	if (cfg.Width>>lowres)*(cfg.Height>>lowres) > maxOversizePixels {
		return nil, fmt.Errorf("%w: %dx%d", errOversize, cfg.Width, cfg.Height)
	}

	args := []string{"-noautorotate"}
	if lowres > 0 {
		args = append(args, "-lowres", fmt.Sprint(lowres))
	}
	args = append(args,
		"-i", path,
		"-vf", fmt.Sprintf("scale=w=%d:h=%d:force_original_aspect_ratio=decrease", maxDim, maxDim),
	)
	return ffmpegFrame(context.Background(), bin, args)
}
