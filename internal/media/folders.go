package media

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Jishnu-Prasad888/Cairn/internal/likeutil"
)

// ErrFolderIntoItself is returned when a folder would be moved inside itself.
var ErrFolderIntoItself = errors.New("a folder cannot be moved inside itself")

// safeFolderPath cleans a folder path and refuses the library root and hidden
// segments (hidden folders are never listed, so one would vanish from view).
func safeFolderPath(raw string) (string, error) {
	safe, err := SafeRelPath(raw)
	if err != nil {
		return "", err
	}
	if safe == "" || safe == "." {
		return "", fmt.Errorf("%w: the library root is not a folder that can be changed", ErrPathTraversal)
	}
	for _, seg := range strings.Split(safe, "/") {
		if strings.HasPrefix(seg, ".") {
			return "", fmt.Errorf("%w: hidden folder names are not allowed", ErrPathTraversal)
		}
	}
	return safe, nil
}

// MoveFolder renames or moves the folder at relPath, with everything in it, to
// newRelPath. A rename is a move to a new name in the same parent.
//
// The directory is renamed on disk in one step, then every indexed file under
// it (and any favourite of the folder or a sub-folder) is rewritten to the new
// path, so tags, albums, notes, faces and favourites — all keyed by file id —
// follow the files instead of being re-discovered as new ones.
func (svc *Service) MoveFolder(ctx context.Context, relPath, newRelPath string) (*Folder, error) {
	from, err := safeFolderPath(relPath)
	if err != nil {
		return nil, err
	}
	to, err := safeFolderPath(newRelPath)
	if err != nil {
		return nil, err
	}
	if from == to {
		return svc.folderAt(ctx, to)
	}
	if strings.HasPrefix(to+"/", from+"/") {
		return nil, ErrFolderIntoItself
	}
	fromAbs, _ := svc.absPath(from)
	toAbs, _ := svc.absPath(to)

	info, err := os.Stat(fromAbs)
	if err != nil || !info.IsDir() {
		return nil, ErrFolderNotFound
	}
	// Only a different folder counts as taken: on a case-insensitive disk a
	// rename that only changes case finds itself here.
	if existing, statErr := os.Stat(toAbs); statErr == nil && !os.SameFile(existing, info) {
		return nil, ErrAlreadyExists
	}
	if err := os.MkdirAll(filepath.Dir(toAbs), 0o755); err != nil {
		return nil, fmt.Errorf("create destination directory: %w", err)
	}
	if err := os.Rename(fromAbs, toAbs); err != nil {
		return nil, fmt.Errorf("move folder: %w", err)
	}
	if err := svc.store.MovePathsUnder(ctx, from, to); err != nil {
		// Put the directory back so disk and index still agree.
		if back := os.Rename(toAbs, fromAbs); back != nil {
			return nil, fmt.Errorf("update index after folder move: %w (and moving it back failed: %v)", err, back)
		}
		return nil, fmt.Errorf("update index after folder move: %w", err)
	}
	return svc.folderAt(ctx, to)
}

// FolderInfo describes the folder at relPath as it is on disk now, with its
// stats; ErrFolderNotFound when there is no such directory.
func (svc *Service) FolderInfo(ctx context.Context, relPath string) (*Folder, error) {
	safe, err := safeFolderPath(relPath)
	if err != nil {
		return nil, err
	}
	abs, _ := svc.absPath(safe)
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return nil, ErrFolderNotFound
	}
	f, _ := svc.folderAt(ctx, safe)
	if f.ModTime.IsZero() {
		f.ModTime = info.ModTime()
	}
	return f, nil
}

// folderAt describes the folder at a clean path, with its stats.
func (svc *Service) folderAt(ctx context.Context, rel string) (*Folder, error) {
	f := &Folder{ID: rel, RelPath: rel, Name: path.Base(rel)}
	if st, err := svc.store.StatsUnder(ctx, rel); err == nil {
		f.FileCount, f.SizeBytes, f.ModTime = st.Count, st.SizeBytes, st.Latest
	}
	return f, nil
}

// TrashFolder moves every file in the folder (and its sub-folders) to the
// trash, one by one, so each can be restored on its own from the Trash page,
// then removes the directories left empty. It reports how many files went to
// the trash. Files that could not be moved stay where they are, with their
// folders, and the first failure is returned alongside the count. allow, when
// non-nil, decides per file whether the caller may delete it; a file it
// refuses is left in place (and keeps its folder).
func (svc *Service) TrashFolder(
	ctx context.Context, relPath, actorID string, allow func(relPath string) bool,
) (int, error) {
	safe, err := safeFolderPath(relPath)
	if err != nil {
		return 0, err
	}
	abs, _ := svc.absPath(safe)
	if info, statErr := os.Stat(abs); statErr != nil || !info.IsDir() {
		return 0, ErrFolderNotFound
	}
	paths, err := svc.store.PresentPathsUnder(ctx, safe)
	if err != nil {
		return 0, err
	}
	trashed := 0
	var firstErr error
	for _, p := range paths {
		if allow != nil && !allow(p) {
			continue
		}
		if err := svc.Delete(ctx, p, actorID); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("trash %s: %w", p, err)
			}
			continue
		}
		trashed++
	}
	removeEmptyDirs(abs)
	return trashed, firstErr
}

// removeEmptyDirs deletes dir and every directory beneath it that is (or
// becomes) empty, deepest first. Anything with a file left in it stays.
func removeEmptyDirs(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			removeEmptyDirs(filepath.Join(dir, e.Name()))
		}
	}
	_ = os.Remove(dir) // fails, harmlessly, when something is still inside
}

// WriteFolderZip streams the present files under the folder to w as a zip
// archive, with paths relative to the folder (so "Trips/2024/a.jpg" is
// "2024/a.jpg" inside "Trips.zip"). Files are stored, not deflated: photos
// and videos are already compressed, and storing keeps the server's CPU free.
// include, when non-nil, decides per file whether the caller may read it.
func (svc *Service) WriteFolderZip(
	ctx context.Context, relPath string, w io.Writer, include func(relPath string) bool,
) error {
	safe, err := safeFolderPath(relPath)
	if err != nil {
		return err
	}
	abs, _ := svc.absPath(safe)
	if info, statErr := os.Stat(abs); statErr != nil || !info.IsDir() {
		return ErrFolderNotFound
	}
	paths, err := svc.store.PresentPathsUnder(ctx, safe)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(w)
	for _, p := range paths {
		if err := ctx.Err(); err != nil {
			return err
		}
		if include != nil && !include(p) {
			continue
		}
		if err := svc.addZipEntry(zw, p, strings.TrimPrefix(p, safe+"/")); err != nil {
			return err
		}
	}
	return zw.Close()
}

func (svc *Service) addZipEntry(zw *zip.Writer, relPath, name string) error {
	abs, err := svc.absPath(relPath)
	if err != nil {
		return err
	}
	src, err := os.Open(abs)
	if err != nil {
		// Gone since it was indexed: leave it out rather than fail the archive.
		return nil
	}
	defer func() { _ = src.Close() }()
	info, err := src.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	hdr, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	hdr.Name = name
	hdr.Method = zip.Store
	dst, err := zw.CreateHeader(hdr)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, src)
	return err
}

// --- store ---

// PresentPathsUnder lists the paths of present files in folderPath and every
// folder beneath it, in path order.
func (s *FileStore) PresentPathsUnder(ctx context.Context, folderPath string) ([]string, error) {
	prefix := filepath.ToSlash(folderPath) + "/"
	lo, hi := likeutil.PrefixRange(prefix)
	rows, err := s.db.QueryContext(ctx,
		`SELECT rel_path FROM indexed_files
		 WHERE status = ? AND rel_path >= ? AND rel_path < ? AND rel_path LIKE ? `+likeutil.EscapeClause+`
		 ORDER BY rel_path`,
		string(FileStatusPresent), lo, hi, likeutil.Escape(prefix)+"%")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// MovePathsUnder rewrites the path of every indexed file under from to sit
// under to instead, and does the same for favourite folders, in one
// transaction. Trashed files keep the path they will be restored to.
func (s *FileStore) MovePathsUnder(ctx context.Context, from, to string) error {
	from = filepath.ToSlash(from)
	to = filepath.ToSlash(to)
	prefix := from + "/"
	lo, hi := likeutil.PrefixRange(prefix)
	like := likeutil.Escape(prefix) + "%"
	now := rfc3339(time.Now().UTC())

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// substr is 1-based and counts characters, not bytes: everything after
	// "from/" is kept and put after "to/".
	keep := utf8.RuneCountInString(prefix) + 1
	if _, err := tx.ExecContext(ctx,
		`UPDATE indexed_files SET rel_path = ? || substr(rel_path, ?), last_seen_at = ?
		 WHERE status != ? AND rel_path >= ? AND rel_path < ? AND rel_path LIKE ? `+likeutil.EscapeClause,
		to+"/", keep, now, string(FileStatusDeleted), lo, hi, like); err != nil {
		return fmt.Errorf("move indexed files: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE favorite_folders SET rel_path = ? WHERE rel_path = ?`, to, from); err != nil {
		return fmt.Errorf("move favourite folder: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE favorite_folders SET rel_path = ? || substr(rel_path, ?)
		 WHERE rel_path >= ? AND rel_path < ? AND rel_path LIKE ? `+likeutil.EscapeClause,
		to+"/", keep, lo, hi, like); err != nil {
		return fmt.Errorf("move favourite sub-folders: %w", err)
	}
	return tx.Commit()
}
