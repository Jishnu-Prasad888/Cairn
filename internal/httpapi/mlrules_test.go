package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/ml"
)

func TestMLRulesAndCrowdLimit(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	admin, libs, member := newLibraryListServerWith(t, func(d *Dependencies) {
		sim := ml.NewManager(logger, ml.Config{}, ml.AverageHashProvider{})
		faces := ml.NewFaceManager(logger, ml.FaceConfig{}, nil)
		d.ML, d.Faces = sim, faces
		d.MLRuntime = ml.NewRuntime(d.DB, logger, sim, faces, true,
			func(context.Context) ([]ml.Target, error) { return nil, nil })
	})
	lib := libs[0]
	base := "/api/v1/libraries/" + lib.ID + "/ml/rules"

	rec := admin.do(t, http.MethodPut, base, map[string]any{"rules": []ml.Rule{
		{Kind: ml.RuleSkip, Path: filepath.Join(lib.Root, "screenshots")},
		{Kind: ml.RuleAlways, Path: "screenshots/keep.png"},
	}})
	if rec.Code != http.StatusOK {
		t.Fatalf("put = %d, body=%s", rec.Code, rec.Body.String())
	}
	rec = admin.do(t, http.MethodGet, base, nil)
	var resp struct {
		Rules []ml.Rule `json:"rules"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Rules) != 2 || resp.Rules[0] != (ml.Rule{Kind: ml.RuleSkip, Path: "screenshots"}) {
		t.Errorf("rules = %+v", resp.Rules)
	}

	for name, rules := range map[string][]ml.Rule{
		"outside": {{Kind: ml.RuleSkip, Path: "/etc"}},
		"both":    {{Kind: ml.RuleSkip, Path: "a"}, {Kind: ml.RuleAlways, Path: "a"}},
	} {
		if rec := admin.do(t, http.MethodPut, base, map[string]any{"rules": rules}); rec.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, rec.Code)
		}
	}
	if rec := member().do(t, http.MethodGet, base, nil); rec.Code != http.StatusForbidden {
		t.Errorf("member = %d, want 403", rec.Code)
	}

	rec = admin.do(t, http.MethodPut, "/api/v1/ml/settings", map[string]int{"crowd_limit": 8})
	if rec.Code != http.StatusOK {
		t.Fatalf("set crowd limit = %d, body=%s", rec.Code, rec.Body.String())
	}
	var settings mlSettings
	if err := json.Unmarshal(rec.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if settings.CrowdLimit != 8 {
		t.Errorf("crowd_limit = %d, want 8", settings.CrowdLimit)
	}
	if rec := admin.do(t, http.MethodPut, "/api/v1/ml/settings", map[string]int{"crowd_limit": -1}); rec.Code != http.StatusBadRequest {
		t.Errorf("negative crowd limit = %d, want 400", rec.Code)
	}
}
