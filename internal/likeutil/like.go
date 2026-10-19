// Package likeutil escapes SQL LIKE wildcards in user-supplied path segments
// used to build prefix filters, and exposes the shared ESCAPE clause string.
//
// A folder literally named "a_b" or "100%" must never widen a child/member
// query to siblings; escaping makes the wildcards literal.
package likeutil

import "strings"

// Escape returns s with LIKE wildcards (% _ \) made literal for use on the
// right-hand side of a LIKE comparison paired with EscapeClause.
func Escape(s string) string {
	return strings.NewReplacer(
		`\`, `\\`,
		`%`, `\%`,
		`_`, `\_`,
	).Replace(s)
}

// EscapeClause is the SQL tail that declares the escape character used by
// Escape. Append it to every LIKE/NOT LIKE comparison whose argument went
// through Escape.
const EscapeClause = "ESCAPE '\\'"

// PrefixRange returns bounds lo and hi such that a string has prefix exactly
// when lo <= s < hi under SQLite's default BINARY collation. A LIKE prefix
// filter cannot use an index on a BINARY column (LIKE ignores ASCII case), so
// pairing it with "col >= lo AND col < hi" lets SQLite seek straight to the
// matching rows instead of scanning every one. The pair also makes the match
// case-sensitive, as file paths on disk are.
//
// prefix must be non-empty; the bound is the prefix with its last byte
// incremented, which for a folder prefix ("a/b/") is simply "a/b0".
func PrefixRange(prefix string) (lo, hi string) {
	b := []byte(prefix)
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] < 0xff {
			b[i]++
			return prefix, string(b[:i+1])
		}
	}
	// All 0xff bytes: no finite upper bound. Unreachable for UTF-8 paths.
	return prefix, prefix + "\xff\xff\xff\xff"
}
