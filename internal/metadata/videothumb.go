package metadata

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"io"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/safeimage"
)

// videoFrameTimeout bounds one ffmpeg invocation, so a damaged or enormous
// file can never hold a worker (or a thumbnail request) indefinitely.
const videoFrameTimeout = 30 * time.Second

// MaxPosterBytes caps a client-captured video frame (PUT .../thumbnail).
const MaxPosterBytes = 8 << 20

// ErrNoVideoDecoder is returned when no ffmpeg binary is on PATH.
var ErrNoVideoDecoder = errors.New("ffmpeg is not available")

// ffmpegPath is resolved once; an empty result means video frames cannot be
// extracted on the server and clients capture them instead.
var ffmpegPath = sync.OnceValue(func() string {
	p, err := exec.LookPath("ffmpeg")
	if err != nil {
		return ""
	}
	return p
})

// VideoFramesAvailable reports whether the server can extract video frames.
func VideoFramesAvailable() bool { return ffmpegPath() != "" }

// ffmpegVersion is the installed ffmpeg's major and minor version, resolved
// once. A build from git ("N-…") counts as newer than any release; a version
// that cannot be read is 0.0.
var ffmpegVersion = sync.OnceValue(func() [2]int {
	bin := ffmpegPath()
	if bin == "" {
		return [2]int{}
	}
	out, err := exec.Command(bin, "-hide_banner", "-version").Output()
	if err != nil {
		return [2]int{}
	}
	return parseFFmpegVersion(string(out))
})

var ffmpegVersionRe = regexp.MustCompile(`^ffmpeg version n?(N-|(\d+)\.(\d+))`)

func parseFFmpegVersion(out string) [2]int {
	m := ffmpegVersionRe.FindStringSubmatch(out)
	switch {
	case m == nil:
		return [2]int{}
	case m[1] == "N-":
		return [2]int{1 << 30, 0}
	}
	major, _ := strconv.Atoi(m[2])
	minor, _ := strconv.Atoi(m[3])
	return [2]int{major, minor}
}

// stillMinFFmpeg lists the photo formats Go cannot decode but ffmpeg can,
// with the first ffmpeg release that decodes them whole. AVIF is read since
// 6.0. HEIC from a phone is a grid of tiles, which ffmpeg composes only
// since 7.1; an earlier one could make a thumbnail of a single tile.
var stillMinFFmpeg = map[string][2]int{
	".avif": {6, 0},
	".heic": {7, 1},
	".heif": {7, 1},
}

// stillFramesAvailable reports whether the photo at path is in a format
// that only ffmpeg decodes, and the installed one decodes it correctly.
func stillFramesAvailable(path string) bool {
	minVersion, ok := stillMinFFmpeg[strings.ToLower(filepath.Ext(path))]
	if !ok || !VideoFramesAvailable() {
		return false
	}
	v := ffmpegVersion()
	return v[0] > minVersion[0] || (v[0] == minVersion[0] && v[1] >= minVersion[1])
}

// extractVideoFrame decodes the first frame of the video at path.
func extractVideoFrame(ctx context.Context, path string) (image.Image, error) {
	// The first video stream, never a cover image or subtitle track.
	return extractFrame(ctx, path, "-map", "0:v:0")
}

// extractStill decodes the photo at path with ffmpeg. ffmpeg chooses the
// stream itself: for a tiled HEIC that is the composed image, where the
// first video stream would be one tile.
func extractStill(ctx context.Context, path string) (image.Image, error) {
	return extractFrame(ctx, path)
}

// extractFrame decodes one frame of the file at path. The file is only read;
// ffmpeg writes the frame as a PNG to its stdout.
func extractFrame(ctx context.Context, path string, selectStream ...string) (image.Image, error) {
	bin := ffmpegPath()
	if bin == "" {
		return nil, ErrNoVideoDecoder
	}
	// "-scale" keeps the decoded frame small before it reaches Go; the
	// thumbnail is resized again by resizeToFit with the photo pipeline.
	args := []string{"-i", path}
	args = append(args, selectStream...)
	args = append(args, "-vf", fmt.Sprintf("scale='min(%d,iw)':-2", ThumbnailSize*2))
	return ffmpegFrame(ctx, bin, args)
}

// ffmpegFrame runs ffmpeg with args (its input and filters) and decodes the
// one frame it writes, as a PNG, to its stdout.
func ffmpegFrame(ctx context.Context, bin string, args []string) (image.Image, error) {
	ctx, cancel := context.WithTimeout(ctx, videoFrameTimeout)
	defer cancel()

	args = append([]string{"-nostdin", "-hide_banner", "-loglevel", "error"}, args...)
	args = append(args, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-")
	cmd := exec.CommandContext(ctx, bin, args...)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffmpeg: %w: %s", err, bytes.TrimSpace(stderr.Bytes()))
	}
	img, _, err := safeimage.Decode(bytes.NewReader(out.Bytes()))
	if err != nil {
		return nil, fmt.Errorf("decode frame: %w", err)
	}
	return img, nil
}

// StorePoster stores a video frame captured by a client (the browser draws
// the video's first frame to a canvas) as the file's thumbnail. The bytes are
// decoded with the same safety limits as photos and re-encoded, so nothing a
// client sends is written verbatim. An existing thumbnail is kept: a frame
// the server extracted itself always wins.
func StorePoster(r io.Reader, cairnDir, fileID string, keys *crypto.Keys) (stored bool, err error) {
	if _, _, err := ReadThumb(cairnDir, fileID, keys); err == nil {
		return false, nil
	}
	data, err := io.ReadAll(io.LimitReader(r, MaxPosterBytes+1))
	if err != nil {
		return false, fmt.Errorf("read poster: %w", err)
	}
	if len(data) > MaxPosterBytes {
		return false, fmt.Errorf("poster exceeds %d bytes", MaxPosterBytes)
	}
	img, _, err := safeimage.Decode(bytes.NewReader(data))
	if err != nil {
		return false, fmt.Errorf("decode poster: %w", err)
	}
	if err := writeThumb(img, cairnDir, fileID, keys); err != nil {
		return false, err
	}
	return true, nil
}
