package ml

import (
	_ "embed"
	"fmt"
	"image"
	"math"
	"sync"

	pigo "github.com/esimov/pigo/core"

	"github.com/Jishnu-Prasad888/Cairn/internal/ml/onnx"
)

//go:embed cascade/puploc
var pupilCascade []byte

// Reference eye positions of the 112x112 aligned face crop that ArcFace-style
// networks (InsightFace MobileFaceNet / ResNet) are trained on.
const (
	alignSize      = 112
	refLeftEyeX    = 38.2946
	refLeftEyeY    = 51.6963
	refRightEyeX   = 73.5318
	refRightEyeY   = 51.5014
	pupilPerturbs  = 63
	embedDimension = 512

	// MinEmbeddingConfidence is the detector score floor (pigo Q/100) when the
	// embedding model is in use.
	MinEmbeddingConfidence = 0.12
)

var (
	pupilOnce sync.Once
	pupilCls  *pigo.PuplocCascade
	pupilErr  error
)

func pupilClassifier() (*pigo.PuplocCascade, error) {
	pupilOnce.Do(func() {
		pupilCls, pupilErr = pigo.NewPuplocCascade().UnpackCascade(pupilCascade)
	})
	return pupilCls, pupilErr
}

// EmbeddingFaceProvider recognises faces with a learned embedding network
// (an ArcFace-family ONNX model such as InsightFace's MobileFaceNet). Faces
// are found by the same pigo detector as before, aligned on the eyes the way
// the network was trained, and mapped to an L2-normalised 512-d vector. Two
// photos of one person land close together across pose, lighting, expression
// and age, which the old 16x16 pixel descriptor could not do.
type EmbeddingFaceProvider struct {
	*PigoFaceProvider
	model *onnx.Model
	path  string
}

// NewEmbeddingFaceProvider loads the ONNX recognition model at path.
func NewEmbeddingFaceProvider(path string, minSize int, minConfidence float64) (*EmbeddingFaceProvider, error) {
	m, err := onnx.Load(path)
	if err != nil {
		return nil, fmt.Errorf("load face model %s: %w", path, err)
	}
	// A dry run proves the network works and has the expected output width.
	out, err := m.Run(alignedTensor(image.NewRGBA(image.Rect(0, 0, 8, 8)), eyePair{0, 0, 7, 0}))
	if err != nil {
		return nil, fmt.Errorf("face model %s: %w", path, err)
	}
	if len(out.Data) != embedDimension {
		return nil, fmt.Errorf("face model %s: embedding has %d values, want %d", path, len(out.Data), embedDimension)
	}
	// pigo scores real faces well above its noise floor; the low default that
	// suited the old matcher lets in textures and foliage, which would each
	// become a "person". The embedding network makes no attempt to reject them.
	minConfidence = max(minConfidence, MinEmbeddingConfidence)
	return &EmbeddingFaceProvider{
		PigoFaceProvider: NewPigoFaceProvider(minSize, minConfidence),
		model:            m,
		path:             path,
	}, nil
}

// Name returns the provider identifier.
func (*EmbeddingFaceProvider) Name() string { return "mobilefacenet" }

// Version is bumped whenever alignment or the network changes.
func (*EmbeddingFaceProvider) Version() int { return 2 }

// DefaultThreshold is the cosine similarity at which two embeddings are
// treated as the same person when clustering.
func (*EmbeddingFaceProvider) DefaultThreshold() float64 { return 0.5 }

// Describe returns a short human-readable summary.
func (*EmbeddingFaceProvider) Describe() string {
	return "pigo face detection + eye alignment + MobileFaceNet 512-d embedding (local)"
}

type eyePair struct{ lx, ly, rx, ry float64 } // image-left eye, image-right eye

// Embed aligns the face on its eyes and runs the recognition network.
func (p *EmbeddingFaceProvider) Embed(img image.Image, box FaceBox) ([]float32, error) {
	if box.Width <= 0 || box.Height <= 0 {
		return nil, fmt.Errorf("degenerate face box %+v", box)
	}
	out, err := p.model.Run(alignedTensor(img, findEyes(img, box)))
	if err != nil {
		return nil, err
	}
	return l2Normalize(out.Data), nil
}

// findEyes locates both pupils inside a detected face. When the pupil
// localiser gives up, the average eye position for a frontal face is used, so
// a face is never dropped for lack of landmarks.
func findEyes(img image.Image, box FaceBox) eyePair {
	cx := float64(box.X) + float64(box.Width)/2
	cy := float64(box.Y) + float64(box.Height)/2
	s := float64(box.Width)
	est := eyePair{cx - 0.185*s, cy - 0.085*s, cx + 0.185*s, cy - 0.085*s}

	cls, err := pupilClassifier()
	if err != nil {
		return est
	}
	b := img.Bounds()
	// Work on the face neighbourhood only: the localiser samples a few
	// face-widths around the eyes, and converting a whole photo per face would
	// dominate the run time.
	pad := box.Width
	x0, y0 := max(b.Min.X, box.X-pad), max(b.Min.Y, box.Y-pad)
	x1, y1 := min(b.Max.X, box.X+box.Width+pad), min(b.Max.Y, box.Y+box.Height+pad)
	if x1-x0 < 8 || y1-y0 < 8 {
		return est
	}
	region := image.Rect(x0, y0, x1, y1)
	params := pigo.ImageParams{
		Pixels: imageToGrayPixels(img, region),
		Rows:   region.Dy(), Cols: region.Dx(), Dim: region.Dx(),
	}
	row := int(cy) - y0
	col := int(cx) - x0
	locate := func(dx float64) (float64, float64, bool) {
		pl := cls.RunDetector(pigo.Puploc{
			Row:      row - int(0.085*s),
			Col:      col + int(dx*s),
			Scale:    float32(s * 0.4),
			Perturbs: pupilPerturbs,
		}, params, 0.0, false)
		if pl.Row <= 0 || pl.Col <= 0 {
			return 0, 0, false
		}
		return float64(pl.Col + x0), float64(pl.Row + y0), true
	}
	lx, ly, okL := locate(-0.185)
	rx, ry, okR := locate(0.185)
	if !okL || !okR {
		return est
	}
	// Reject implausible results: eyes must be roughly level and a sensible
	// fraction of the face width apart, otherwise the localiser latched onto
	// something else.
	d := math.Hypot(rx-lx, ry-ly)
	if d < 0.2*s || d > 0.6*s || math.Abs(ry-ly) > 0.5*d || rx <= lx {
		return est
	}
	return eyePair{lx, ly, rx, ry}
}

// alignedTensor warps the image so the eyes land on the reference positions
// of a 112x112 crop and returns the network input: RGB, channel-first,
// (v-127.5)/127.5.
func alignedTensor(img image.Image, e eyePair) *onnx.Tensor {
	// Similarity transform (rotation + uniform scale + translation) taking the
	// reference eyes to the detected ones; sampling runs output -> source.
	dx, dy := e.rx-e.lx, e.ry-e.ly
	rdx, rdy := refRightEyeX-refLeftEyeX, refRightEyeY-refLeftEyeY
	scale := math.Hypot(dx, dy) / math.Hypot(rdx, rdy)
	ang := math.Atan2(dy, dx) - math.Atan2(rdy, rdx)
	cos, sin := math.Cos(ang)*scale, math.Sin(ang)*scale
	// source = R*(out - refLeft) + leftEye
	b := img.Bounds()
	t := &onnx.Tensor{Shape: []int{1, 3, alignSize, alignSize}, Data: make([]float32, 3*alignSize*alignSize)}
	plane := alignSize * alignSize
	for y := 0; y < alignSize; y++ {
		for x := 0; x < alignSize; x++ {
			ox, oy := float64(x)-refLeftEyeX, float64(y)-refLeftEyeY
			sx := cos*ox - sin*oy + e.lx
			sy := sin*ox + cos*oy + e.ly
			r, g, bl := bilinear(img, b, sx, sy)
			i := y*alignSize + x
			t.Data[i] = (r - 127.5) / 127.5
			t.Data[plane+i] = (g - 127.5) / 127.5
			t.Data[2*plane+i] = (bl - 127.5) / 127.5
		}
	}
	return t
}

// bilinear samples the image at a fractional position, clamping at the edges,
// and returns 0..255 channel values.
func bilinear(img image.Image, b image.Rectangle, x, y float64) (r, g, bl float32) {
	x0, y0 := math.Floor(x), math.Floor(y)
	fx, fy := float32(x-x0), float32(y-y0)
	px := func(ix, iy int) (float32, float32, float32) {
		ix = min(max(ix, b.Min.X), b.Max.X-1)
		iy = min(max(iy, b.Min.Y), b.Max.Y-1)
		cr, cg, cb, _ := img.At(ix, iy).RGBA()
		return float32(cr >> 8), float32(cg >> 8), float32(cb >> 8)
	}
	ix, iy := int(x0), int(y0)
	r00, g00, b00 := px(ix, iy)
	r10, g10, b10 := px(ix+1, iy)
	r01, g01, b01 := px(ix, iy+1)
	r11, g11, b11 := px(ix+1, iy+1)
	mix := func(a, b, c, d float32) float32 {
		return (a*(1-fx)+b*fx)*(1-fy) + (c*(1-fx)+d*fx)*fy
	}
	return mix(r00, r10, r01, r11), mix(g00, g10, g01, g11), mix(b00, b10, b01, b11)
}

func l2Normalize(v []float32) []float32 {
	var n float64
	for _, x := range v {
		n += float64(x) * float64(x)
	}
	out := make([]float32, len(v))
	if n == 0 {
		return out
	}
	inv := float32(1 / math.Sqrt(n))
	for i, x := range v {
		out[i] = x * inv
	}
	return out
}
