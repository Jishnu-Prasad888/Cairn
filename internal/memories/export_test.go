package memories

import (
	"strings"
	"testing"
	"time"
)

func TestSlug(t *testing.T) {
	cases := map[string]string{
		"My Trip to Kerala":      "my-trip-to-kerala",
		"  Hello,   World!!  ":   "hello-world",
		"2024-05-01":             "2024-05-01",
		"":                       "memory",
		"!!!":                    "memory",
		"Kerala 2026 — Monsoon":  "kerala-2026-monsoon",
		"Héllo Wörld":            "héllo-wörld",
		strings.Repeat("a", 200): strings.Repeat("a", 80),
	}
	for in, want := range cases {
		if got := Slug(in); got != want {
			t.Errorf("Slug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBuildExportFrontMatterAndBlocks(t *testing.T) {
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	date := time.Date(2024, 5, 1, 0, 0, 0, 0, time.UTC)
	m := &Memory{
		ID:          "mem12345",
		Title:       `Trip "to" Kerala`,
		Description: "Monsoon\ntrip",
		Location:    "Kochi",
		Tags:        []string{"travel", `family "fun"`},
		MemoryDate:  &date,
		Revision:    7,
		CreatedAt:   now,
		UpdatedAt:   now,
		Blocks: []*Block{
			{ID: "b1", Type: BlockText, Markdown: "# Day one\nWe left early."},
			{ID: "b2", Type: BlockImage, Layout: LayoutGrid, Slideshow: true, SlideshowInterval: intp(20), Images: []*Image{
				{ID: "i1", SourceFileID: "f1", SourceRelPath: "photos/1.jpg", Caption: "The road -- to Munnar",
					Edits: Edits{Rotation: 90, Filter: FilterWarm, Adjustments: Adjustments{Brightness: 5}}},
				{ID: "i2", SourceFileID: "f2", SourceRelPath: "private/2.jpg", Caption: "Hidden"},
			}},
		},
	}
	opts := ExportOptions{
		DocName: "trip-to-kerala.md",
		Images: map[string]ExportImage{
			"i1": {Name: "images/01.jpg", SourcePath: "photos/1.jpg"},
			"i2": {Reason: "forbidden"},
		},
		Now: now,
	}

	out := BuildExport(m, opts)

	for _, want := range []string{
		`title: "Trip \"to\" Kerala"`,
		`date: "2024-05-01"`,
		`description: "Monsoon\ntrip"`,
		`location: "Kochi"`,
		`tags: ["travel", "family \"fun\""]`,
		`cairn_memory_id: "mem12345"`,
		`cairn_revision: 7`,
		`cairn_exported_at: "2026-10-09T12:00:00Z"`,
		"# Day one\nWe left early.",
		`<!-- cairn:image-block layout="grid" slideshow="true" interval="20" -->`,
		`![The road -- to Munnar](images/01.jpg)`,
		`source="photos/1.jpg"`,
		`edit="rotation=90 filter=warm brightness=5"`,
		`unavailable="forbidden"`,
		`caption="Hidden"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("export missing %q\n---\n%s", want, out)
		}
	}
	// A caption containing "--" must not close the comment early.
	if strings.Contains(out, "The road -- to Munnar -->") {
		t.Errorf("caption broke out of comment:\n%s", out)
	}
	if strings.Contains(out, `![Hidden]`) {
		t.Errorf("unavailable image should not be linked:\n%s", out)
	}
}

func TestBuildExportLegacyBodyAndCover(t *testing.T) {
	m := &Memory{ID: "m1", Title: "Plain", Body: "Just a body."}
	out := BuildExport(m, ExportOptions{CoverName: "images/cover.jpg", Now: time.Now()})
	if !strings.Contains(out, "cover: \"images/cover.jpg\"") {
		t.Errorf("cover missing:\n%s", out)
	}
	if !strings.HasSuffix(out, "\nJust a body.\n") {
		t.Errorf("legacy body not emitted:\n%s", out)
	}
}

func TestBuildExportEscapesCommentBreakout(t *testing.T) {
	m := &Memory{
		ID: "m1", Title: "x",
		Blocks: []*Block{{ID: "b1", Type: BlockImage, Layout: LayoutGrid, Images: []*Image{
			{ID: "i1", SourceFileID: "f1", Caption: `evil --> <script> "quote"`},
		}}},
	}
	out := BuildExport(m, ExportOptions{Images: map[string]ExportImage{"i1": {Name: "images/01.jpg"}}})
	start := strings.Index(out, "<!-- cairn:image ")
	if start < 0 {
		t.Fatalf("no image comment:\n%s", out)
	}
	end := strings.Index(out[start:], " -->")
	if end < 0 {
		t.Fatalf("comment not terminated:\n%s", out)
	}
	comment := out[start : start+end]
	if strings.Contains(comment, "-->") || strings.Contains(comment, "<script>") {
		t.Errorf("caption broke out of comment: %q", comment)
	}
	if !strings.Contains(comment, `caption="evil &#45;&#45;&gt; &lt;script&gt; &quot;quote&quot;"`) {
		t.Errorf("caption not escaped: %q", comment)
	}
}

func intp(v int) *int { return &v }
