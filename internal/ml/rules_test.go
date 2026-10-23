package ml_test

import (
	"context"
	"errors"
	"path/filepath"
	"sort"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/ml"
)

func TestNormalizeRules(t *testing.T) {
	root := filepath.FromSlash("/photos")
	got, err := ml.NormalizeRules(root, []ml.Rule{
		{Kind: ml.RuleAlways, Path: "trips/2019/best.jpg"},
		{Kind: ml.RuleSkip, Path: "/photos/screenshots/"},
		{Kind: ml.RuleSkip, Path: "screenshots"}, // a repeat
		{Kind: ml.RuleSkip, Path: `memes\old`},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []ml.Rule{
		{Kind: ml.RuleSkip, Path: "memes/old"},
		{Kind: ml.RuleSkip, Path: "screenshots"},
		{Kind: ml.RuleAlways, Path: "trips/2019/best.jpg"},
	}
	if len(got) != len(want) {
		t.Fatalf("rules = %+v; want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("rule %d = %+v; want %+v", i, got[i], want[i])
		}
	}

	for name, bad := range map[string]ml.Rule{
		"outside":  {Kind: ml.RuleSkip, Path: "../elsewhere"},
		"abs out":  {Kind: ml.RuleSkip, Path: "/etc/passwd"},
		"root":     {Kind: ml.RuleSkip, Path: "/"},
		"empty":    {Kind: ml.RuleAlways, Path: "  "},
		"cairn":    {Kind: ml.RuleSkip, Path: ".cairn/thumbs"},
		"bad kind": {Kind: "maybe", Path: "a"},
	} {
		var re *ml.RuleError
		if _, err := ml.NormalizeRules(root, []ml.Rule{bad}); !errors.As(err, &re) {
			t.Errorf("%s: err = %v; want a RuleError", name, err)
		}
	}
	if _, err := ml.NormalizeRules(root, []ml.Rule{
		{Kind: ml.RuleSkip, Path: "a"}, {Kind: ml.RuleAlways, Path: "a/"},
	}); err == nil {
		t.Error("one path both skipped and always included: want an error")
	}
}

// face records one detected face with a one-hot descriptor on axis.
func face(fileID string, axis int) ml.FaceRecord {
	d := make([]float32, 256)
	d[axis] = 1
	return ml.FaceRecord{
		ID: fileID + "-" + string(rune('a'+axis)), FileID: fileID, Provider: "fake_faces", Version: 1,
		Box: ml.FaceBox{Width: 50, Height: 50, Confidence: 0.9}, Descriptor: d,
	}
}

// Skip rules drop a folder's faces; an always rule keeps one photo inside it.
// Faces in a photo over the crowd limit only join people already known.
func TestFaceRulesAndCrowdLimit(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	seedFiles(t, root, []imgSeed{
		{id: "a1", rel: "home/a1.png"},
		{id: "a2", rel: "home/a2.png"},
		{id: "crowd", rel: "party/crowd.png"},
		{id: "s1", rel: "screens/s1.png"},
		{id: "keep", rel: "screens/keep.png"},
	})
	db, err := librarydb.OpenDB(filepath.Join(root, ".cairn"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	store := ml.NewFaceStore(db.DB())
	const ann, bob, cat, dan, eve = 1, 2, 3, 4, 5
	for file, faces := range map[string][]ml.FaceRecord{
		"a1":    {face("a1", ann)},
		"a2":    {face("a2", ann)},
		"crowd": {face("crowd", ann), face("crowd", bob), face("crowd", cat)},
		"s1":    {face("s1", dan)},
		"keep":  {face("keep", eve)},
	} {
		if err := store.RecordFaceScan(ctx, file, "fake_faces", 1, faces); err != nil {
			t.Fatal(err)
		}
	}
	rules, err := ml.NormalizeRules(root, []ml.Rule{
		{Kind: ml.RuleSkip, Path: "screens"},
		{Kind: ml.RuleAlways, Path: "screens/keep.png"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := ml.SaveRules(ctx, db.DB(), rules); err != nil {
		t.Fatal(err)
	}

	m := ml.NewFaceManager(tLog(), ml.FaceConfig{Enabled: true, Threshold: 0.9, MinSize: 20}, fakeFaceProvider{})
	m.SetCrowdLimit(2)
	if _, err := m.ClusterPass(ctx, root); err != nil {
		t.Fatal(err)
	}

	people, err := m.People(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(people) != 1 || people[0].FaceCount != 3 {
		t.Fatalf("people = %+v; want Ann alone, found in both home photos and the crowd", people)
	}
	unassigned := func() []string {
		t.Helper()
		faces, err := m.Unassigned(ctx, root)
		if err != nil {
			t.Fatal(err)
		}
		var files []string
		for _, f := range faces {
			files = append(files, f.FileID)
		}
		sort.Strings(files)
		return files
	}
	// Bob and Cat (crowd strangers) are kept but not offered; Dan was in a
	// skipped folder and is gone; Eve's photo is always included.
	if got := unassigned(); len(got) != 1 || got[0] != "keep" {
		t.Errorf("unassigned faces from %v; want only Eve's (keep)", got)
	}
	if n, _ := store.CountFaces(ctx); n != 6 {
		t.Errorf("stored faces = %d; want 6 (Dan's dropped, the crowd's kept)", n)
	}
	if files, _ := store.FilesToScan(ctx, "fake_faces", 1); len(files) != 0 {
		t.Errorf("files to scan = %+v; want none (s1 is skipped)", files)
	}

	// An always rule over the party lifts the crowd limit there.
	rules = append(rules, ml.Rule{Kind: ml.RuleAlways, Path: "party"})
	if err := ml.SaveRules(ctx, db.DB(), rules); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ClusterPass(ctx, root); err != nil {
		t.Fatal(err)
	}
	if got := unassigned(); len(got) != 3 {
		t.Errorf("unassigned faces from %v; want Bob, Cat and Eve", got)
	}
}

// Similar images skip what face recognition skips, and drop old signatures.
func TestSimilaritySkipsRuledPhotos(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	seedFiles(t, root, []imgSeed{
		{id: "a", rel: "a.png"},
		{id: "s", rel: "skip_me/s.png"},
		{id: "k", rel: "skip_me/keep/k.png"},
	})
	db, err := librarydb.OpenDB(filepath.Join(root, ".cairn"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	store := ml.NewStore(db.DB())
	if err := store.Upsert(ctx, ml.SignatureRecord{FileID: "s", Provider: "p", Version: 1, Signature: 7}); err != nil {
		t.Fatal(err)
	}
	if err := ml.SaveRules(ctx, db.DB(), []ml.Rule{
		{Kind: ml.RuleSkip, Path: "skip_me"},
		{Kind: ml.RuleAlways, Path: "skip_me/keep"},
		// "_" is a LIKE wildcard; it must not make "skipXme" match.
		{Kind: ml.RuleSkip, Path: "skipXme"},
	}); err != nil {
		t.Fatal(err)
	}
	if n, err := store.DropSkipped(ctx); err != nil || n != 1 {
		t.Errorf("DropSkipped = %d, %v; want 1", n, err)
	}
	files, err := store.IDsWithoutSignature(ctx, "p", 1)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, f := range files {
		ids = append(ids, f.FileID)
	}
	sort.Strings(ids)
	if len(ids) != 2 || ids[0] != "a" || ids[1] != "k" {
		t.Errorf("to sign = %v; want a and k", ids)
	}
	if skipped, _ := store.IsSkipped(ctx, "s"); !skipped {
		t.Error("s should be skipped")
	}
}
