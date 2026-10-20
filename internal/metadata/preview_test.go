package metadata

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
)

// jpegWithOrientation encodes img as a JPEG carrying a minimal EXIF block
// with the given orientation tag.
func jpegWithOrientation(t *testing.T, img image.Image, orientation uint16) []byte {
	t.Helper()
	var body bytes.Buffer
	if err := jpeg.Encode(&body, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	// TIFF header (little endian), one IFD with the Orientation tag.
	var tiff bytes.Buffer
	tiff.WriteString("II*\x00")
	_ = binary.Write(&tiff, binary.LittleEndian, uint32(8))
	_ = binary.Write(&tiff, binary.LittleEndian, uint16(1))
	_ = binary.Write(&tiff, binary.LittleEndian, []uint16{0x0112, 3})
	_ = binary.Write(&tiff, binary.LittleEndian, uint32(1))
	_ = binary.Write(&tiff, binary.LittleEndian, []uint16{orientation, 0})
	_ = binary.Write(&tiff, binary.LittleEndian, uint32(0))
	app1 := append([]byte("Exif\x00\x00"), tiff.Bytes()...)

	var out bytes.Buffer
	out.Write(body.Bytes()[:2]) // SOI
	out.Write([]byte{0xFF, 0xE1})
	_ = binary.Write(&out, binary.BigEndian, uint16(len(app1)+2))
	out.Write(app1)
	out.Write(body.Bytes()[2:])
	return out.Bytes()
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func previewConfig(t *testing.T, cairnDir, id string, keys *crypto.Keys) (image.Image, image.Config) {
	t.Helper()
	data, _, err := ReadPreview(cairnDir, id, keys)
	if err != nil {
		t.Fatalf("ReadPreview: %v", err)
	}
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	return img, image.Config{Width: img.Bounds().Dx(), Height: img.Bounds().Dy()}
}

func TestGeneratePreviewScalesLargePhoto(t *testing.T) {
	dir := t.TempDir()
	cairnDir := filepath.Join(dir, ".cairn")
	src := filepath.Join(dir, "big.jpg")
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4100, 2050)), nil)
	writeFile(t, src, buf.Bytes())

	keys := crypto.NewKeys("a phrasey passphrase")
	ok, err := GeneratePreview(src, cairnDir, "p1", keys)
	if err != nil || !ok {
		t.Fatalf("GeneratePreview = %v, %v; want true, nil", ok, err)
	}
	raw, _ := os.ReadFile(PreviewPath(cairnDir, "p1"))
	if !crypto.IsSealed(raw) {
		t.Fatal("on-disk preview is not sealed")
	}
	_, cfg := previewConfig(t, cairnDir, "p1", keys)
	if cfg.Width != PreviewSize || cfg.Height != PreviewSize/2 {
		t.Errorf("preview = %dx%d, want %dx%d", cfg.Width, cfg.Height, PreviewSize, PreviewSize/2)
	}
}

func TestGeneratePreviewSkipsWhenOriginalServes(t *testing.T) {
	dir := t.TempDir()
	cairnDir := filepath.Join(dir, ".cairn")

	small := filepath.Join(dir, "small.jpg")
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 800, 600)), nil)
	writeFile(t, small, buf.Bytes())

	anim := filepath.Join(dir, "big.gif")
	buf.Reset()
	pal := image.NewPaletted(image.Rect(0, 0, 3000, 10), color.Palette{color.Black, color.White})
	_ = gif.EncodeAll(&buf, &gif.GIF{Image: []*image.Paletted{pal, pal}, Delay: []int{10, 10}})
	writeFile(t, anim, buf.Bytes())

	for _, src := range []string{small, anim} {
		ok, err := GeneratePreview(src, cairnDir, "skip", crypto.NewKeys(""))
		if err != nil || ok {
			t.Errorf("GeneratePreview(%s) = %v, %v; want false, nil", filepath.Base(src), ok, err)
		}
	}
	if _, err := os.Stat(PreviewPath(cairnDir, "skip")); !os.IsNotExist(err) {
		t.Errorf("a preview was written for a file the original serves: %v", err)
	}
}

func TestGeneratePreviewAppliesOrientation(t *testing.T) {
	// A small landscape photo tagged "turn a quarter clockwise": left half
	// white, right half black. Upright it is portrait with white on top.
	img := image.NewRGBA(image.Rect(0, 0, 400, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 400; x++ {
			c := color.RGBA{0, 0, 0, 255}
			if x < 200 {
				c = color.RGBA{255, 255, 255, 255}
			}
			img.SetRGBA(x, y, c)
		}
	}
	dir := t.TempDir()
	cairnDir := filepath.Join(dir, ".cairn")
	src := filepath.Join(dir, "turned.jpg")
	writeFile(t, src, jpegWithOrientation(t, img, 6))

	ok, err := GeneratePreview(src, cairnDir, "o6", crypto.NewKeys(""))
	if err != nil || !ok {
		t.Fatalf("GeneratePreview = %v, %v; want true, nil (orientation forces one)", ok, err)
	}
	got, cfg := previewConfig(t, cairnDir, "o6", crypto.NewKeys(""))
	if cfg.Width != 200 || cfg.Height != 400 {
		t.Fatalf("preview = %dx%d, want 200x400", cfg.Width, cfg.Height)
	}
	top, _, _, _ := got.At(100, 50).RGBA()
	bottom, _, _, _ := got.At(100, 350).RGBA()
	if top < 0xc000 || bottom > 0x4000 {
		t.Errorf("preview not upright: top=%#x bottom=%#x, want white over black", top, bottom)
	}
}

func TestBoxShrinkAverages(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 4, 2))
	for x := 0; x < 4; x++ {
		v := uint8(0)
		if x%2 == 1 {
			v = 200
		}
		src.SetRGBA(x, 0, color.RGBA{v, v, v, 255})
		src.SetRGBA(x, 1, color.RGBA{v, v, v, 255})
	}
	got := boxShrink(src, 2).(*image.RGBA)
	if b := got.Bounds(); b.Dx() != 2 || b.Dy() != 1 {
		t.Fatalf("bounds = %v, want 2x1", b)
	}
	for x := 0; x < 2; x++ {
		if c := got.RGBAAt(x, 0); c.R != 100 || c.A != 255 {
			t.Errorf("pixel %d = %v, want grey 100", x, c)
		}
	}

	ycc := image.NewYCbCr(image.Rect(0, 0, 4, 4), image.YCbCrSubsampleRatio420)
	for i := range ycc.Y {
		ycc.Y[i] = 128
	}
	for i := range ycc.Cb {
		ycc.Cb[i], ycc.Cr[i] = 128, 128
	}
	c := boxShrink(ycc, 2).(*image.RGBA).RGBAAt(1, 1)
	if c.R != 128 || c.G != 128 || c.B != 128 {
		t.Errorf("YCbCr grey shrank to %v, want 128 grey", c)
	}
}
