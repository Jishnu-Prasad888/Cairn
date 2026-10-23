package ml

import (
	"context"
	"database/sql"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Which photos machine learning looks at.
//
// A rule names a path inside the library: one file, or a folder and
// everything under it. "skip" keeps photos out of face recognition and
// similar-image search altogether; their faces and signatures are discarded.
// "always" brings photos back in whatever else says: a skip rule over a
// parent folder, or the crowd limit (see FaceManager.CrowdLimit). An always
// rule wins over a skip rule however the two are nested, so the person never
// has to reason about which is more specific.

// RuleKind says what a Rule does.
type RuleKind string

const (
	// RuleSkip leaves photos out of face recognition and similar images.
	RuleSkip RuleKind = "skip"
	// RuleAlways analyses photos fully, past skip rules and the crowd limit.
	RuleAlways RuleKind = "always"
)

// Rule is one path machine learning skips or always includes. Path is
// relative to the library root, /-separated, with no leading or trailing
// slash.
type Rule struct {
	Kind RuleKind `json:"kind"`
	Path string   `json:"path"`
}

// RuleError reports a rule that cannot be saved.
type RuleError struct{ msg string }

func (e *RuleError) Error() string { return e.msg }

// MaxRules bounds how many rules one library may hold.
const MaxRules = 1000

// NormalizeRules validates rules for the library at root and returns them in
// canonical form, sorted and without repeats. A path may be absolute as long
// as it lies inside root. One path cannot be both skipped and always included.
func NormalizeRules(root string, rules []Rule) ([]Rule, error) {
	if len(rules) > MaxRules {
		return nil, &RuleError{fmt.Sprintf("at most %d rules are allowed", MaxRules)}
	}
	kinds := map[string]RuleKind{}
	out := make([]Rule, 0, len(rules))
	for _, r := range rules {
		if r.Kind != RuleSkip && r.Kind != RuleAlways {
			return nil, &RuleError{fmt.Sprintf("unknown rule kind %q", r.Kind)}
		}
		p, err := canonicalRulePath(root, r.Path)
		if err != nil {
			return nil, err
		}
		if k, ok := kinds[p]; ok {
			if k != r.Kind {
				return nil, &RuleError{fmt.Sprintf("%q cannot be both skipped and always included", p)}
			}
			continue
		}
		kinds[p] = r.Kind
		out = append(out, Rule{Kind: r.Kind, Path: p})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind > out[j].Kind // skip before always
		}
		return out[i].Path < out[j].Path
	})
	return out, nil
}

// canonicalRulePath turns a typed path into the library-relative form the
// index stores (indexed_files.rel_path), refusing anything outside it.
func canonicalRulePath(root, p string) (string, error) {
	p = strings.TrimSpace(p)
	if filepath.IsAbs(p) && root != "" {
		rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(p))
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", &RuleError{fmt.Sprintf("%q is not inside the library", p)}
		}
		p = filepath.ToSlash(rel)
	}
	p = strings.Trim(strings.ReplaceAll(p, `\`, "/"), "/")
	if p == "" || p == "." {
		return "", &RuleError{"a rule needs a folder or file inside the library; to stop analysing the whole library, turn machine learning off"}
	}
	clean := path.Clean(p)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", &RuleError{fmt.Sprintf("%q is not inside the library", p)}
	}
	if clean == ".cairn" || strings.HasPrefix(clean, ".cairn/") {
		return "", &RuleError{"Cairn's own .cairn folder is never analysed"}
	}
	return clean, nil
}

// LoadRules returns the library's rules, skip rules first.
func LoadRules(ctx context.Context, db *sql.DB) ([]Rule, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT kind, path FROM ml_rules ORDER BY kind DESC, path`)
	if err != nil {
		return nil, fmt.Errorf("load ml rules: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Rule{}
	for rows.Next() {
		var r Rule
		if err := rows.Scan(&r.Kind, &r.Path); err != nil {
			return nil, fmt.Errorf("scan ml rule: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SaveRules replaces the library's rules with rules (already normalized).
func SaveRules(ctx context.Context, db *sql.DB, rules []Rule) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("save ml rules begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM ml_rules`); err != nil {
		return fmt.Errorf("clear ml rules: %w", err)
	}
	now := rfc3339(time.Now().UTC())
	for _, r := range rules {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO ml_rules (kind, path, created_at) VALUES (?, ?, ?)`,
			string(r.Kind), r.Path, now); err != nil {
			return fmt.Errorf("save ml rule: %w", err)
		}
	}
	return tx.Commit()
}

// ruleCovers is an SQL condition true when a rule of kind covers the file
// whose rel_path is col: that file itself, or a folder above it. substr, not
// LIKE, so a "_" or "%" in a folder name is not a wildcard.
func ruleCovers(kind RuleKind, col string) string {
	return `EXISTS (SELECT 1 FROM ml_rules r WHERE r.kind = '` + string(kind) + `' AND (` +
		col + ` = r.path OR substr(` + col + `, 1, length(r.path) + 1) = r.path || '/'))`
}

// skippedSQL is an SQL condition true when the file whose rel_path is col is
// left out of machine learning.
func skippedSQL(col string) string {
	return `(` + ruleCovers(RuleSkip, col) + ` AND NOT ` + ruleCovers(RuleAlways, col) + `)`
}

// alwaysSQL is an SQL condition true when the file whose rel_path is col is
// analysed fully, past the crowd limit.
func alwaysSQL(col string) string { return ruleCovers(RuleAlways, col) }
