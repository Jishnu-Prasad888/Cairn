package indexer

import (
	"context"
	"database/sql"
	"fmt"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/sanitize"
)

// Kinds of ignore rule.
const (
	// IgnorePath leaves out one path inside the library: a folder and
	// everything under it, or a single file.
	IgnorePath = "path"
	// IgnoreExtension leaves out every file with this extension.
	IgnoreExtension = "extension"
	// IgnoreName leaves out every file or folder whose name matches a glob
	// pattern such as "Thumbs.db", "*.tmp" or "@eaDir".
	IgnoreName = "name"
)

// Limits on ignore rules, so a library's list stays something a person can
// read and the scanner's per-file check stays cheap.
const (
	maxIgnoreRules   = 500
	maxIgnorePattern = 1024
)

// IgnoreRule is one thing the scanner leaves out of a library's index.
type IgnoreRule struct {
	Kind    string `json:"kind"`
	Pattern string `json:"pattern"`
}

// IgnoreRuleError reports a rule that cannot be saved.
type IgnoreRuleError struct {
	Rule   IgnoreRule
	Reason string
}

func (e *IgnoreRuleError) Error() string {
	return fmt.Sprintf("ignore rule %s %q: %s", e.Rule.Kind, e.Rule.Pattern, e.Reason)
}

// NormalizeIgnoreRules validates rules and puts each in its canonical form,
// dropping duplicates. A path may be given relative to the library root or as
// an absolute path inside it; it is stored relative. An extension loses any
// leading "*." or "." and is lower-cased.
func NormalizeIgnoreRules(root string, rules []IgnoreRule) ([]IgnoreRule, error) {
	if len(rules) > maxIgnoreRules {
		return nil, &IgnoreRuleError{Reason: fmt.Sprintf("at most %d rules are allowed", maxIgnoreRules)}
	}
	out := make([]IgnoreRule, 0, len(rules))
	seen := make(map[IgnoreRule]bool, len(rules))
	for _, r := range rules {
		n, err := normalizeIgnoreRule(root, r)
		if err != nil {
			return nil, err
		}
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out, nil
}

func normalizeIgnoreRule(root string, r IgnoreRule) (IgnoreRule, error) {
	fail := func(reason string) (IgnoreRule, error) {
		return IgnoreRule{}, &IgnoreRuleError{Rule: r, Reason: reason}
	}
	p := strings.TrimSpace(r.Pattern)
	switch {
	case p == "":
		return fail("must not be empty")
	case len(p) > maxIgnorePattern:
		return fail(fmt.Sprintf("must be at most %d characters", maxIgnorePattern))
	}

	switch r.Kind {
	case IgnorePath:
		if filepath.IsAbs(p) {
			rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(p))
			if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return fail("must be inside the library")
			}
			p = rel
		}
		clean, err := sanitize.RelPath(strings.Trim(filepath.ToSlash(p), "/"))
		if err != nil {
			return fail("must be a path inside the library")
		}
		return IgnoreRule{Kind: IgnorePath, Pattern: clean}, nil

	case IgnoreExtension:
		p = strings.TrimPrefix(p, "*")
		p = strings.ToLower(strings.TrimPrefix(p, "."))
		if p == "" || strings.ContainsAny(p, `/\*?[`) {
			return fail("must be a plain extension such as \"xmp\"")
		}
		return IgnoreRule{Kind: IgnoreExtension, Pattern: p}, nil

	case IgnoreName:
		if strings.ContainsAny(p, `/\`) {
			return fail("must be a file or folder name, not a path")
		}
		if _, err := path.Match(p, ""); err != nil {
			return fail("is not a valid pattern")
		}
		return IgnoreRule{Kind: IgnoreName, Pattern: p}, nil
	}
	return fail("kind must be path, extension or name")
}

// LoadIgnoreRules returns a library's ignore rules in the order they were
// added.
func LoadIgnoreRules(ctx context.Context, db *sql.DB) ([]IgnoreRule, error) {
	rows, err := db.QueryContext(ctx, `SELECT kind, pattern FROM ignore_rules ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("query ignore rules: %w", err)
	}
	defer func() { _ = rows.Close() }()
	rules := []IgnoreRule{}
	for rows.Next() {
		var r IgnoreRule
		if err := rows.Scan(&r.Kind, &r.Pattern); err != nil {
			return nil, fmt.Errorf("scan ignore rule: %w", err)
		}
		rules = append(rules, r)
	}
	return rules, rows.Err()
}

// SaveIgnoreRules replaces a library's ignore rules. Rules must already be
// normalized (NormalizeIgnoreRules).
func SaveIgnoreRules(ctx context.Context, db *sql.DB, rules []IgnoreRule) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin ignore rules: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM ignore_rules`); err != nil {
		return fmt.Errorf("clear ignore rules: %w", err)
	}
	now := rfc3339(time.Now())
	for _, r := range rules {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO ignore_rules (kind, pattern, created_at) VALUES (?, ?, ?)`,
			r.Kind, r.Pattern, now); err != nil {
			return fmt.Errorf("insert ignore rule: %w", err)
		}
	}
	return tx.Commit()
}

// ignorer answers whether a scan should leave a path out. The zero value and
// nil ignore nothing.
type ignorer struct {
	paths []string            // slash-separated relative paths
	exts  map[string]struct{} // lower-case, without the dot
	names []string            // lower-case glob patterns
}

func newIgnorer(rules []IgnoreRule) *ignorer {
	if len(rules) == 0 {
		return nil
	}
	ig := &ignorer{exts: map[string]struct{}{}}
	for _, r := range rules {
		switch r.Kind {
		case IgnorePath:
			ig.paths = append(ig.paths, r.Pattern)
		case IgnoreExtension:
			ig.exts[r.Pattern] = struct{}{}
		case IgnoreName:
			ig.names = append(ig.names, strings.ToLower(r.Pattern))
		}
	}
	return ig
}

// skip reports whether rel (slash-separated, relative to the root) is left
// out. Folders are checked as the walk reaches them, so a path rule only has
// to match exactly: everything under an ignored folder is never visited.
func (ig *ignorer) skip(rel string, isDir bool) bool {
	if ig == nil {
		return false
	}
	if slices.Contains(ig.paths, rel) {
		return true
	}
	name := strings.ToLower(path.Base(rel))
	for _, pat := range ig.names {
		if ok, _ := path.Match(pat, name); ok {
			return true
		}
	}
	if !isDir {
		if ext := path.Ext(name); ext != "" {
			if _, ok := ig.exts[ext[1:]]; ok {
				return true
			}
		}
	}
	return false
}
