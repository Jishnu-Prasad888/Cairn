package memories

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// ExportImage describes how one image reference is represented in an exported
// Markdown document. Name is the archive-relative path of the embedded file
// (for example "images/01.jpg"); when the file could not be embedded, Name is
// empty and Reason explains why.
type ExportImage struct {
	Name       string
	Reason     string
	SourcePath string
}

// ExportOptions shape a single export.
type ExportOptions struct {
	// DocName is the Markdown file's own name, kept for link tooling.
	DocName string
	// CoverName is the archive path of the embedded cover image, if any.
	CoverName string
	// Images maps an image ID to its export representation.
	Images map[string]ExportImage
	// Now is stamped into the front matter as the export time.
	Now time.Time
}

// BuildExport renders a memory as a portable Markdown document with YAML front
// matter. Text blocks carry their Markdown verbatim. Image blocks link to the
// embedded image files and preserve Cairn-specific presentation data in HTML
// comments, which renderers ignore but a future importer can read back. Images
// that were not embedded (missing, or unreadable by the caller) are kept as
// comments so no information is silently dropped.
func BuildExport(m *Memory, opts ExportOptions) string {
	var b strings.Builder
	writeExportFrontMatter(&b, m, opts)

	var parts []string
	for _, blk := range m.Blocks {
		if blk == nil {
			continue
		}
		switch blk.Type {
		case BlockText:
			if md := strings.TrimRight(blk.Markdown, "\n"); md != "" {
				parts = append(parts, md)
			}
		case BlockImage:
			parts = append(parts, renderImageBlock(blk, opts))
		}
	}
	// A memory written before the block model has only a joined body.
	if len(m.Blocks) == 0 {
		if body := strings.TrimRight(m.Body, "\n"); body != "" {
			parts = append(parts, body)
		}
	}

	body := strings.Join(parts, "\n\n")
	if body != "" {
		b.WriteString("\n")
		b.WriteString(body)
		b.WriteString("\n")
	}
	return b.String()
}

func writeExportFrontMatter(b *strings.Builder, m *Memory, opts ExportOptions) {
	b.WriteString("---\n")
	fmt.Fprintf(b, "title: %s\n", yamlString(m.Title))
	if m.MemoryDate != nil {
		fmt.Fprintf(b, "date: %s\n", yamlString(m.MemoryDate.Format("2006-01-02")))
	}
	if m.Description != "" {
		fmt.Fprintf(b, "description: %s\n", yamlString(m.Description))
	}
	if m.Location != "" {
		fmt.Fprintf(b, "location: %s\n", yamlString(m.Location))
	}
	if len(m.Tags) > 0 {
		b.WriteString("tags: [")
		for i, tag := range m.Tags {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(yamlString(tag))
		}
		b.WriteString("]\n")
	}
	if opts.CoverName != "" {
		fmt.Fprintf(b, "cover: %s\n", yamlString(opts.CoverName))
	}
	fmt.Fprintf(b, "cairn_memory_id: %s\n", yamlString(m.ID))
	fmt.Fprintf(b, "cairn_revision: %d\n", m.Revision)
	if !m.CreatedAt.IsZero() {
		fmt.Fprintf(b, "cairn_created_at: %s\n", yamlString(m.CreatedAt.UTC().Format(time.RFC3339)))
	}
	if !m.UpdatedAt.IsZero() {
		fmt.Fprintf(b, "cairn_updated_at: %s\n", yamlString(m.UpdatedAt.UTC().Format(time.RFC3339)))
	}
	if !opts.Now.IsZero() {
		fmt.Fprintf(b, "cairn_exported_at: %s\n", yamlString(opts.Now.UTC().Format(time.RFC3339)))
	}
	b.WriteString("---\n")
}

func renderImageBlock(blk *Block, opts ExportOptions) string {
	var b strings.Builder
	b.WriteString("<!-- cairn:image-block")
	b.WriteString(" layout=" + commentValue(string(blk.Layout)))
	b.WriteString(" slideshow=" + commentValue(strconv.FormatBool(blk.Slideshow)))
	if blk.SlideshowInterval != nil {
		b.WriteString(" interval=" + commentValue(strconv.Itoa(*blk.SlideshowInterval)))
	}
	b.WriteString(" -->")

	for _, img := range blk.Images {
		if img == nil {
			continue
		}
		b.WriteString("\n\n")
		ex := opts.Images[img.ID]
		if ex.Name != "" {
			fmt.Fprintf(&b, "![%s](%s)", linkText(img.Caption), ex.Name)
			b.WriteString("\n\n")
		}
		b.WriteString(imageComment(img, ex))
	}
	return b.String()
}

func imageComment(img *Image, ex ExportImage) string {
	var attrs []string
	attrs = append(attrs, "image_id="+commentValue(img.ID))
	// SourcePath is supplied by the caller only when the requesting user may
	// read the file, so a forbidden reference never leaks its path.
	if ex.SourcePath != "" {
		attrs = append(attrs, "source="+commentValue(ex.SourcePath))
	}
	if img.Caption != "" {
		attrs = append(attrs, "caption="+commentValue(img.Caption))
	}
	switch {
	case ex.Name == "":
		reason := ex.Reason
		if reason == "" {
			reason = "unavailable"
		}
		attrs = append(attrs, "unavailable="+commentValue(reason))
	case !img.Edits.IsDefault():
		if edit := editAttributes(img.Edits); edit != "" {
			attrs = append(attrs, "edit="+commentValue(edit))
		}
	}
	return "<!-- cairn:image " + strings.Join(attrs, " ") + " -->"
}

// editAttributes renders the non-default parts of an edit pipeline. The names
// match the API's memory_image fields.
func editAttributes(e Edits) string {
	var parts []string
	if c := e.Crop; c != nil {
		parts = append(parts, fmt.Sprintf("crop=%.5f,%.5f,%.5f,%.5f", c.X, c.Y, c.Width, c.Height))
	}
	if e.Rotation != 0 {
		parts = append(parts, fmt.Sprintf("rotation=%d", e.Rotation))
	}
	if e.Filter != "" && e.Filter != FilterOriginal {
		parts = append(parts, "filter="+e.Filter)
	}
	if a := e.Adjustments; a.Brightness != 0 {
		parts = append(parts, fmt.Sprintf("brightness=%d", a.Brightness))
	}
	if a := e.Adjustments; a.Contrast != 0 {
		parts = append(parts, fmt.Sprintf("contrast=%d", a.Contrast))
	}
	if a := e.Adjustments; a.Saturation != 0 {
		parts = append(parts, fmt.Sprintf("saturation=%d", a.Saturation))
	}
	return strings.Join(parts, " ")
}

// yamlString renders s as a double-quoted YAML scalar, escaping what YAML and
// round-trips cannot carry literally.
func yamlString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// commentValue renders s as a quoted HTML-comment attribute value. It also
// neutralises "--" (illegal in a comment and able to close it early) and angle
// brackets so user text cannot break out of the comment.
func commentValue(s string) string {
	s = strings.NewReplacer(
		"\r", " ",
		"\n", " ",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"--", "&#45;&#45;",
	).Replace(s)
	if strings.HasSuffix(s, "-") {
		s += " "
	}
	return `"` + s + `"`
}

// linkText escapes a caption so it cannot break out of a Markdown link label.
func linkText(s string) string {
	return strings.NewReplacer(
		"\r", " ",
		"\n", " ",
		`\`, `\\`,
		`[`, `\[`,
		`]`, `\]`,
	).Replace(s)
}

// Slug reduces a title to a safe, lowercase file name stem. It keeps Unicode
// letters and digits and folds every other run of characters to a single dash,
// capped at 80 runes so titles cannot produce unwieldy names.
func Slug(title string) string {
	var b strings.Builder
	count := 0
	dashed := false
	for _, r := range title {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			if count >= 80 {
				break
			}
			b.WriteRune(unicode.ToLower(r))
			count++
			dashed = false
			continue
		}
		if count > 0 && !dashed {
			b.WriteByte('-')
			dashed = true
		}
	}
	s := strings.Trim(b.String(), "-")
	if s == "" {
		return "memory"
	}
	return s
}
