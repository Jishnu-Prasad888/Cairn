package ml_test

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/ml"
)

// fakeFaceProvider detects the single brightest point of an image, reporting
// a 24x24 box around it, and embeds a one-hot vector keyed on that position.
// Two images with a bright point at the same position share a descriptor and
// so cluster together; a bright point elsewhere becomes a different person.
type fakeFaceProvider struct{}

func (fakeFaceProvider) Name() string     { return "fake_faces" }
func (fakeFaceProvider) Version() int     { return 1 }
func (fakeFaceProvider) Describe() string { return "test provider" }

// brightPoint scans for the brightest pixel location in an image.
func brightPoint(img image.Image) (int, int, bool) {
	b := img.Bounds()
	bestX, bestY := b.Min.X, b.Min.Y
	var best uint32
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, _ := img.At(x, y).RGBA()
			lum := (r*299 + g*587 + bl*114) >> 10
			if lum > best {
				best = lum
				bestX, bestY = x, y
			}
		}
	}
	if best == 0 {
		return 0, 0, false
	}
	return bestX, bestY, true
}

func (fakeFaceProvider) Detect(img image.Image) ([]ml.FaceBox, error) {
	cx, cy, ok := brightPoint(img)
	if !ok {
		return nil, nil
	}
	return []ml.FaceBox{{X: cx - 12, Y: cy - 12, Width: 24, Height: 24, Confidence: 0.5}}, nil
}

func (fakeFaceProvider) Embed(img image.Image, _ ml.FaceBox) ([]float32, error) {
	cx, cy, ok := brightPoint(img)
	if !ok {
		return make([]float32, 256), nil
	}
	b := img.Bounds()
	xb := ((cx - b.Min.X) * 16) / b.Dx()
	yb := ((cy - b.Min.Y) * 16) / b.Dy()
	if xb > 15 {
		xb = 15
	}
	if yb > 15 {
		yb = 15
	}
	v := make([]float32, 256)
	v[yb*16+xb] = 1
	return v, nil
}

func TestFaceProviderDetectBlank(t *testing.T) {
	p := ml.NewPigoFaceProvider(0, 0)
	if p.Name() == "" || p.Version() != 1 {
		t.Fatalf("provider identity invalid: %+v", p)
	}
	img := image.NewGray(image.Rect(0, 0, 320, 240))
	for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
		for x := img.Bounds().Min.X; x < img.Bounds().Max.X; x++ {
			img.SetGray(x, y, color.Gray{Y: 10})
		}
	}
	faces, err := p.Detect(img)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(faces) != 0 {
		t.Errorf("Detect on blank image = %d faces, want 0", len(faces))
	}
}

func TestFaceProviderEmbedDeterministic(t *testing.T) {
	p := ml.NewPigoFaceProvider(0, 0)
	img := image.NewGray(image.Rect(0, 0, 64, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 64; x++ {
			img.SetGray(x, y, color.Gray{Y: uint8(x*4 + y)})
		}
	}
	box := ml.FaceBox{X: 20, Y: 12, Width: 24, Height: 24, Confidence: 0.9}
	a, err := p.Embed(img, box)
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}
	if len(a) != 256 {
		t.Fatalf("descriptor length = %d, want 256", len(a))
	}
	b, err := p.Embed(img, box)
	if err != nil {
		t.Fatalf("Embed 2nd: %v", err)
	}
	sim := ml.DescriptorCosine(a, b)
	if sim < 0.999 {
		t.Errorf("self cosine = %f, want ~1", sim)
	}
	jpegBytes, err := ml.FaceJPEG(img, box, 0)
	if err != nil {
		t.Fatalf("FaceJPEG: %v", err)
	}
	if len(jpegBytes) == 0 {
		t.Error("FaceJPEG returned empty bytes")
	}
}

func TestFaceStoreLifecycle(t *testing.T) {
	root := t.TempDir()
	seedFiles(t, root, []imgSeed{{id: "file0", rel: "img0.png"}})

	db, err := librarydb.OpenDB(filepath.Join(root, ".cairn"))
	if err != nil {
		t.Fatal(err)
	}
	store := ml.NewFaceStore(db.DB())
	ctx := context.Background()

	f1 := ml.FaceRecord{ID: "face1", FileID: "file0", Provider: "p", Version: 1,
		Box:        ml.FaceBox{X: 1, Y: 2, Width: 24, Height: 24, Confidence: 0.9},
		Descriptor: []float32{1, 0, 0}}
	f2 := ml.FaceRecord{ID: "face2", FileID: "file0", Provider: "p", Version: 1,
		Box:        ml.FaceBox{X: 50, Y: 50, Width: 24, Height: 24, Confidence: 0.8},
		Descriptor: []float32{0, 1, 0}}
	if err := store.InsertFace(ctx, f1); err != nil {
		t.Fatalf("InsertFace: %v", err)
	}
	if err := store.InsertFace(ctx, f2); err != nil {
		t.Fatalf("InsertFace 2: %v", err)
	}

	p, err := store.CreatePerson(ctx, "Mom")
	if err != nil {
		t.Fatalf("CreatePerson: %v", err)
	}
	if err := store.AssignPerson(ctx, p.ID, f1.ID, "manual"); err != nil {
		t.Fatalf("AssignPerson: %v", err)
	}
	if err := store.RenamePerson(ctx, p.ID, "Mum"); err != nil {
		t.Fatalf("RenamePerson: %v", err)
	}
	if err := store.SetCover(ctx, p.ID, f1.ID); err != nil {
		t.Fatalf("SetCover: %v", err)
	}

	people, err := store.ListPeople(ctx)
	if err != nil || len(people) != 1 {
		t.Fatalf("ListPeople = %+v, %v; want 1", people, err)
	}
	if people[0].FaceCount != 1 || people[0].CoverFaceID != "face1" {
		t.Errorf("person = %+v; want FaceCount 1 cover face1", people[0])
	}
	if people[0].Name != "Mum" {
		t.Errorf("renamed person = %q, want Mum", people[0].Name)
	}

	unassigned, err := store.FacesUnassigned(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(unassigned) != 1 || unassigned[0].ID != "face2" {
		t.Errorf("unassigned = %+v; want only face2", unassigned)
	}

	// A face can belong to only one person; assigning moves it.
	if err := store.AssignPerson(ctx, p.ID, f2.ID, "auto"); err != nil {
		t.Fatal(err)
	}
	pf, err := store.PersonFaces(ctx, p.ID)
	if err != nil || len(pf) != 2 {
		t.Fatalf("PersonFaces = %+v, %v; want 2", pf, err)
	}
	if err := store.UnassignPerson(ctx, p.ID, f2.ID); err != nil {
		t.Fatalf("UnassignPerson: %v", err)
	}
	people, _ = store.ListPeople(ctx)
	if people[0].FaceCount != 1 {
		t.Errorf("after unassign FaceCount = %d, want 1", people[0].FaceCount)
	}

	// Purge keeps people, drops faces.
	n, err := store.PurgeFaces(ctx)
	if err != nil || n != 2 {
		t.Fatalf("PurgeFaces = %d, %v; want 2", n, err)
	}
	people, _ = store.ListPeople(ctx)
	if len(people) != 1 || people[0].CoverFaceID != "" {
		t.Errorf("after purge people = %+v; want 1 with no cover", people)
	}
	_ = db.Close()
}

func TestFaceManagerPassClusterPurge(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()

	images := []struct {
		id, name string
		cx       int
	}{
		{"file0", "mom1.png", 40},
		{"file1", "mom2.png", 40},
		{"file2", "other.png", 160},
	}
	now := "2026-01-01T00:00:00.000Z"
	var files []imgSeed
	for _, im := range images {
		img := image.NewRGBA(image.Rect(0, 0, 200, 200))
		for y := 0; y < 200; y++ {
			for x := 0; x < 200; x++ {
				img.Set(x, y, color.RGBA{R: 10, G: 10, B: 10, A: 255})
			}
		}
		img.Set(im.cx, im.cx, color.RGBA{R: 250, G: 250, B: 250, A: 255})
		files = append(files, imgSeed{id: im.id, rel: im.name, now: now, img: img})
	}
	seedFiles(t, root, files)

	m := ml.NewFaceManager(tLog(), ml.FaceConfig{
		Enabled:       true,
		Workers:       2,
		Threshold:     0.9,
		MinSize:       20,
		MinConfidence: 0.5,
	}, fakeFaceProvider{})

	st, err := m.Status(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Enabled || st.Faces != 0 {
		t.Errorf("initial status = %+v", st)
	}

	n, err := m.Pass(ctx, root)
	if err != nil {
		t.Fatalf("Pass: %v", err)
	}
	if n != 3 {
		t.Errorf("Pass processed %d files, want 3", n)
	}
	if n, err := m.Pass(ctx, root); err != nil || n != 0 {
		t.Errorf("second Pass = %d, %v; want 0", n, err)
	}

	res, err := m.ClusterPass(ctx, root)
	if err != nil {
		t.Fatalf("ClusterPass: %v", err)
	}
	if res.Inspected != 3 || res.Assigned != 1 || res.Created != 2 {
		t.Errorf("ClusterPass = %+v; want inspected 3 assigned 1 created 2", res)
	}

	people, err := m.People(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(people) != 2 {
		t.Fatalf("people = %+v; want 2", people)
	}
	// Sizes must be one person of 2 faces and one of 1.
	if people[0].FaceCount+people[1].FaceCount != 3 || people[0].FaceCount == people[1].FaceCount {
		t.Errorf("person sizes = %d,%d; want {2,1}", people[0].FaceCount, people[1].FaceCount)
	}

	res2, err := m.ClusterPass(ctx, root)
	if err != nil || res2.Inspected != 0 {
		t.Errorf("second ClusterPass = %+v, %v; want inspected 0", res2, err)
	}

	people, _ = m.People(ctx, root)
	for _, p := range people {
		if p.FaceCount == 2 {
			if err := m.RenamePerson(ctx, root, p.ID, "Mom"); err != nil {
				t.Fatal(err)
			}
		}
	}

	mOff := ml.NewFaceManager(tLog(), ml.FaceConfig{Enabled: false}, fakeFaceProvider{})
	if _, err := mOff.Pass(ctx, root); err == nil {
		t.Error("Pass on disabled manager: want error")
	}

	n, err = m.Purge(ctx, root)
	if err != nil || n != 3 {
		t.Errorf("Purge = %d, %v; want 3", n, err)
	}
	people, _ = m.People(ctx, root)
	if len(people) != 2 {
		t.Errorf("after purge people = %d, want 2 (names survive)", len(people))
	}
	var mom bool
	for _, p := range people {
		if p.Name == "Mom" {
			mom = true
			if p.FaceCount != 0 {
				t.Errorf("post-purge Mom FaceCount = %d, want 0", p.FaceCount)
			}
		}
	}
	if !mom {
		t.Error("renamed person Mom lost after purge")
	}
}

type imgSeed struct {
	id, rel, now string
	img          image.Image
}

// seedFiles creates the .cairn dir (when missing), writes any provided files,
// and records an indexed_files + photo media_metadata row for each.
func seedFiles(t *testing.T, root string, files []imgSeed) {
	t.Helper()
	cairnDir := filepath.Join(root, ".cairn")
	if err := os.MkdirAll(cairnDir, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := librarydb.OpenDB(cairnDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	ctx := context.Background()
	now := "2026-01-01T00:00:00.000Z"
	for _, f := range files {
		if f.img != nil {
			writePNGImage(t, filepath.Join(root, f.rel), f.img)
		}
		rel := f.rel
		if rel == "" {
			rel = "img0.png"
		}
		n := f.now
		if n == "" {
			n = now
		}
		if _, err := db.DB().ExecContext(ctx, `
			INSERT INTO indexed_files (id, rel_path, size_bytes, mod_time, status, first_seen_at, last_seen_at, indexed_at)
			VALUES (?, ?, 1, ?, 'present', ?, ?, ?)`, f.id, rel, n, n, n, n); err != nil {
			t.Fatal(err)
		}
		if _, err := db.DB().ExecContext(ctx, `
			INSERT INTO media_metadata (file_id, media_type, updated_at) VALUES (?, 'photo', ?)`, f.id, n); err != nil {
			t.Fatal(err)
		}
	}
}

func writePNGImage(t *testing.T, path string, img image.Image) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}
