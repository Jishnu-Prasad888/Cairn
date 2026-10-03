package ml

import (
	"image"
	"image/color"
	"math"
	"testing"
)

// A face rotated in the photo must be turned upright: after alignment the
// eyes sit at the reference positions whatever the tilt.
func TestAlignmentUprightsRotatedFace(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 200, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 200; x++ {
			img.Set(x, y, color.RGBA{20, 20, 20, 255})
		}
	}
	// Eyes as white dots, tilted 30 degrees about (100,100), 60px apart.
	a := 30 * math.Pi / 180
	lx, ly := 100-30*math.Cos(a), 100-30*math.Sin(a)
	rx, ry := 100+30*math.Cos(a), 100+30*math.Sin(a)
	for dy := -3; dy <= 3; dy++ {
		for dx := -3; dx <= 3; dx++ {
			img.Set(int(lx)+dx, int(ly)+dy, color.White)
			img.Set(int(rx)+dx, int(ry)+dy, color.White)
		}
	}
	tn := alignedTensor(img, eyePair{lx, ly, rx, ry})
	at := func(x, y int) float32 { return tn.Data[y*alignSize+x] }
	if at(38, 52) < 0.5 || at(74, 52) < 0.5 {
		t.Fatalf("eyes not at reference positions: %v %v", at(38, 52), at(74, 52))
	}
	if at(56, 90) > 0 {
		t.Fatal("background should stay dark")
	}
}

func TestEmbeddingNormalisedAndCosine(t *testing.T) {
	v := l2Normalize([]float32{3, 4})
	if math.Abs(float64(v[0]*v[0]+v[1]*v[1])-1) > 1e-6 {
		t.Fatalf("not unit: %v", v)
	}
	if DescriptorCosine(v, v) < 0.999 {
		t.Fatal("self similarity")
	}
}

func unit(v ...float32) []float32 { return l2Normalize(v) }

// After two looks of one person are merged, a face resembling only the second
// look must still match, which an averaged centroid alone would miss.
func TestMatchScoreRecognisesEitherMergedLook(t *testing.T) {
	lookA := unit(1, 0, 0, 0)
	lookB := unit(0, 1, 0, 0)
	ex := []Exemplar{{Descriptor: lookA}, {Descriptor: lookA}, {Descriptor: lookB}, {Descriptor: lookB}}
	centroid := unit(1, 1, 0, 0)

	if got := matchScore(unit(0, 1, 0.1, 0), centroid, ex); got < 0.9 {
		t.Fatalf("second look scored %.2f, want a match", got)
	}
	if got := matchScore(unit(0, 0, 1, 0), centroid, ex); got > 0.2 {
		t.Fatalf("stranger scored %.2f, want a miss", got)
	}
}

// One odd photo must not pull a stranger in: two supporting faces are needed.
func TestMatchScoreNeedsTwoSupportingFaces(t *testing.T) {
	ex := []Exemplar{{Descriptor: unit(1, 0, 0, 0)}, {Descriptor: unit(0, 0, 1, 0)}}
	centroid := unit(1, 0, 1, 0)
	if got := matchScore(unit(1, 0, 0, 0), centroid, ex); got > 0.8 {
		t.Fatalf("a single close face gave %.2f", got)
	}
}

func TestGroupSimilarity(t *testing.T) {
	a := []Exemplar{{Descriptor: unit(1, 0, 0)}, {Descriptor: unit(1, 0.1, 0)}}
	same := []Exemplar{{Descriptor: unit(1, 0.05, 0)}, {Descriptor: unit(1, 0, 0.05)}}
	other := []Exemplar{{Descriptor: unit(0, 0, 1)}, {Descriptor: unit(0, 0.1, 1)}}
	if groupSimilarity(a, same) < 0.95 || groupSimilarity(a, other) > 0.3 {
		t.Fatalf("same=%.2f other=%.2f", groupSimilarity(a, same), groupSimilarity(a, other))
	}
}
