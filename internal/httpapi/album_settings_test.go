package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestAlbumSettingsDefaultsPinsAndHiddenLibraries(t *testing.T) {
	_, client, _, _ := newSearchTestServer(t)
	type pin struct {
		LibraryID string `json:"library_id"`
		AlbumID   string `json:"album_id"`
	}
	var got struct {
		Settings struct {
			Sort            string   `json:"sort"`
			Pinned          []pin    `json:"pinned"`
			HiddenLibraries []string `json:"hidden_libraries"`
		} `json:"settings"`
	}
	rec := client.do(t, http.MethodGet, "/api/v1/settings/albums", nil)
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Settings.Sort != "created_desc" || got.Settings.Pinned == nil || len(got.Settings.Pinned) != 0 {
		t.Fatalf("defaults = %+v", got.Settings)
	}

	pins := []pin{{"l1", "a1"}, {"l1", "a2"}}
	rec = client.do(t, http.MethodPatch, "/api/v1/settings/albums",
		map[string]any{"sort": "name_asc", "pinned": pins, "hidden_libraries": []string{"l2"}})
	if rec.Code != http.StatusOK {
		t.Fatalf("patch = %d %s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got.Settings.Sort != "name_asc" || len(got.Settings.Pinned) != 2 ||
		got.Settings.Pinned[0].AlbumID != "a1" || got.Settings.HiddenLibraries[0] != "l2" {
		t.Fatalf("after patch = %+v", got.Settings)
	}

	six := []pin{{"l", "1"}, {"l", "2"}, {"l", "3"}, {"l", "4"}, {"l", "5"}, {"l", "6"}}
	for name, body := range map[string]map[string]any{
		"six pins":     {"pinned": six},
		"pinned twice": {"pinned": []pin{{"l", "1"}, {"l", "1"}}},
		"bad sort":     {"sort": "size"},
	} {
		if rec := client.do(t, http.MethodPatch, "/api/v1/settings/albums", body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, rec.Code)
		}
	}
	// A refused patch changes nothing.
	rec = client.do(t, http.MethodGet, "/api/v1/settings/albums", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got.Settings.Sort != "name_asc" || len(got.Settings.Pinned) != 2 {
		t.Fatalf("after refused patches = %+v", got.Settings)
	}
}
