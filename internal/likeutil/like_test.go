package likeutil

import "testing"

func TestEscape(t *testing.T) {
	cases := []struct{ in, want string }{
		{"plain", "plain"},
		{"a_b", "a\\_b"},
		{"100%", "100\\%"},
		{"back\\slash", "back\\\\slash"},
		{"a/b", "a/b"}, // path separators are not wildcards
	}
	for _, tc := range cases {
		if got := Escape(tc.in); got != tc.want {
			t.Errorf("Escape(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestPrefixRange(t *testing.T) {
	lo, hi := PrefixRange("a/b/")
	if lo != "a/b/" || hi != "a/b0" {
		t.Fatalf("PrefixRange = %q, %q", lo, hi)
	}
	for _, s := range []string{"a/b/x.jpg", "a/b/c/d.jpg", "a/b/"} {
		if !(s >= lo && s < hi) {
			t.Errorf("%q should be in range", s)
		}
	}
	for _, s := range []string{"a/b", "a/b0", "a/bc/x.jpg", "a/b.jpg", "A/b/x.jpg"} {
		if s >= lo && s < hi {
			t.Errorf("%q should be out of range", s)
		}
	}
}
