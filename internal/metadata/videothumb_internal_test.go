package metadata

import "testing"

func TestParseFFmpegVersion(t *testing.T) {
	for _, tc := range []struct {
		out  string
		want [2]int
	}{
		{"ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023", [2]int{6, 1}},
		{"ffmpeg version n7.1 Copyright", [2]int{7, 1}},
		{"ffmpeg version 7.1.1 Copyright", [2]int{7, 1}},
		{"ffmpeg version N-117043-g1bb7c8b Copyright", [2]int{1 << 30, 0}},
		{"something else", [2]int{}},
	} {
		if got := parseFFmpegVersion(tc.out); got != tc.want {
			t.Errorf("parseFFmpegVersion(%q) = %v, want %v", tc.out, got, tc.want)
		}
	}
}
