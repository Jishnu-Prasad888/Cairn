package ml

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"time"
)

// FaceRecord is one stored face observation for a file.
type FaceRecord struct {
	ID         string
	FileID     string
	Provider   string
	Version    int
	Box        FaceBox
	Descriptor []float32
	CreatedAt  time.Time
	UpdatedAt  time.Time
	// RelPath is populated only by queries that join indexed_files (used to
	// re-open the source image when serving face crops).
	RelPath string
}

// Person is one nameable grouping of faces. Names survive face purges.
type Person struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	CoverFaceID string    `json:"cover_face_id,omitempty"`
	CoverFileID string    `json:"cover_file_id,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	FaceCount   int       `json:"face_count"`
}

// UnsignedFaceFile is a photo that has no faces recorded for a
// provider/version yet.
type UnsignedFaceFile struct {
	FileID  string
	RelPath string
}

// FaceStore persists faces, people, and face-person assignments in the
// per-library database. Like the signature store, it is derived data: the
// whole table may be purged and regenerated, while people (user-curated
// names) survive.
type FaceStore struct {
	db *sql.DB
}

// NewFaceStore wraps a per-library database pool.
func NewFaceStore(db *sql.DB) *FaceStore {
	return &FaceStore{db: db}
}

// FilesToScan returns present photos with no faces recorded for the given
// provider version yet.
func (s *FaceStore) FilesToScan(ctx context.Context, provider string, version int) ([]UnsignedFaceFile, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT f.id, f.rel_path
		FROM indexed_files f
		JOIN media_metadata m ON m.file_id = f.id
		WHERE f.status = 'present'
		  AND m.media_type = 'photo'
		  AND NOT EXISTS (
		      SELECT 1 FROM faces fa
		      WHERE fa.file_id = f.id AND fa.provider = ? AND fa.version = ?
		  )
		ORDER BY f.id`, provider, version)
	if err != nil {
		return nil, fmt.Errorf("list files to face-scan: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var files []UnsignedFaceFile
	for rows.Next() {
		var uf UnsignedFaceFile
		if err := rows.Scan(&uf.FileID, &uf.RelPath); err != nil {
			return nil, fmt.Errorf("scan file to face-scan: %w", err)
		}
		files = append(files, uf)
	}
	return files, rows.Err()
}

// InsertFace writes one face observation.
func (s *FaceStore) InsertFace(ctx context.Context, f FaceRecord) error {
	now := rfc3339(time.Now().UTC())
	c, err := float32Bytes(f.Descriptor)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO faces (id, file_id, provider, version, x, y, width, height,
		                   confidence, descriptor, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		f.ID, f.FileID, f.Provider, f.Version,
		f.Box.X, f.Box.Y, f.Box.Width, f.Box.Height, f.Box.Confidence,
		c, now, now)
	if err != nil {
		return fmt.Errorf("insert face: %w", err)
	}
	return nil
}

// FaceByID returns a face, or nil when not present.
func (s *FaceStore) FaceByID(ctx context.Context, id string) (*FaceRecord, error) {
	var (
		f                            FaceRecord
		descriptor, created, updated string
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT id, file_id, provider, version, x, y, width, height, confidence,
		       descriptor, created_at, updated_at
		FROM faces WHERE id = ?`, id).
		Scan(&f.ID, &f.FileID, &f.Provider, &f.Version,
			&f.Box.X, &f.Box.Y, &f.Box.Width, &f.Box.Height, &f.Box.Confidence,
			&descriptor, &created, &updated)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get face: %w", err)
	}
	desc, err := float32FromBytes([]byte(descriptor))
	if err != nil {
		return nil, err
	}
	f.Descriptor = desc
	if err := parseTime(created, &f.CreatedAt); err != nil {
		return nil, err
	}
	if err := parseTime(updated, &f.UpdatedAt); err != nil {
		return nil, err
	}
	return &f, nil
}

// FacesUnassigned returns faces that belong to no person, oldest first, with
// their image's relative path (used to render crops).
func (s *FaceStore) FacesUnassigned(ctx context.Context) ([]FaceRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT fa.id, fa.file_id, fa.provider, fa.version, fa.x, fa.y, fa.width,
		       fa.height, fa.confidence, fa.descriptor, fa.created_at, fa.updated_at,
		       f.rel_path
		FROM faces fa
		JOIN indexed_files f ON f.id = fa.file_id
		WHERE NOT EXISTS (SELECT 1 FROM person_faces pf WHERE pf.face_id = fa.id)
		ORDER BY fa.created_at, fa.id`)
	if err != nil {
		return nil, fmt.Errorf("list unassigned faces: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []FaceRecord
	for rows.Next() {
		f, err := scanFaceFull(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// PersonMeans returns each person's mean (normalized) descriptor over all
// their assigned faces. People with no faces are absent from the map.
func (s *FaceStore) PersonMeans(ctx context.Context) (map[string][]float32, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT pf.person_id, fa.descriptor
		FROM person_faces pf
		JOIN faces fa ON fa.id = pf.face_id`)
	if err != nil {
		return nil, fmt.Errorf("list person faces: %w", err)
	}
	defer func() { _ = rows.Close() }()

	sums := map[string][]float64{}
	counts := map[string]int{}
	var dim int
	for rows.Next() {
		var pid string
		var blob []byte
		if err := rows.Scan(&pid, &blob); err != nil {
			return nil, fmt.Errorf("scan person face: %w", err)
		}
		desc, err := float32FromBytes(blob)
		if err != nil {
			return nil, err
		}
		if dim == 0 {
			dim = len(desc)
		}
		sum := sums[pid]
		if sum == nil {
			sum = make([]float64, dim)
			sums[pid] = sum
		}
		for i, v := range desc {
			sum[i] += float64(v)
		}
		counts[pid]++
	}

	means := make(map[string][]float32, len(sums))
	for pid, sum := range sums {
		out := make([]float32, len(sum))
		var n float64
		for i, v := range sum {
			av := v / float64(counts[pid])
			out[i] = float32(av)
			n += av * av
		}
		if n == 0 {
			continue // flat person: no mean to compare against
		}
		inv := 1.0 / math.Sqrt(n)
		for i := range out {
			out[i] = float32(float64(out[i]) * inv)
		}
		means[pid] = out
	}
	return means, nil
}

// CountFaces returns the number of stored face observations.
func (s *FaceStore) CountFaces(ctx context.Context) (int, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM faces`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count faces: %w", err)
	}
	return n, nil
}

// CountPeople returns the number of people.
func (s *FaceStore) CountPeople(ctx context.Context) (int, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM people`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count people: %w", err)
	}
	return n, nil
}

// ListPeople returns all people (sorted so the big, meaningful groups sort
// first is left to callers) with their face counts.
func (s *FaceStore) ListPeople(ctx context.Context) ([]Person, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT p.id, p.name, COALESCE(p.cover_face_id, ''), COALESCE(p.cover_file_id, ''),
		       p.created_at, p.updated_at,
		       (SELECT COUNT(*) FROM person_faces pf WHERE pf.person_id = p.id)
		FROM people p
		ORDER BY p.name COLLATE NOCASE, p.id`)
	if err != nil {
		return nil, fmt.Errorf("list people: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []Person
	for rows.Next() {
		var (
			p                Person
			created, updated string
		)
		if err := rows.Scan(&p.ID, &p.Name, &p.CoverFaceID, &p.CoverFileID,
			&created, &updated, &p.FaceCount); err != nil {
			return nil, fmt.Errorf("scan person: %w", err)
		}
		if err := parseTime(created, &p.CreatedAt); err != nil {
			return nil, err
		}
		if err := parseTime(updated, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// PersonFaces returns the faces assigned to a person (used to render covers
// and the person grid).
func (s *FaceStore) PersonFaces(ctx context.Context, personID string) ([]FaceRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT fa.id, fa.file_id, fa.provider, fa.version, fa.x, fa.y, fa.width,
		       fa.height, fa.confidence, fa.descriptor, fa.created_at, fa.updated_at,
		       f.rel_path
		FROM person_faces pf
		JOIN faces fa ON fa.id = pf.face_id
		JOIN indexed_files f ON f.id = fa.file_id
		WHERE pf.person_id = ?
		ORDER BY fa.created_at, fa.id`, personID)
	if err != nil {
		return nil, fmt.Errorf("list person faces: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []FaceRecord
	for rows.Next() {
		f, err := scanFaceFull(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// CreatePerson inserts a person and returns it.
func (s *FaceStore) CreatePerson(ctx context.Context, name string) (*Person, error) {
	id, err := newID()
	if err != nil {
		return nil, err
	}
	now := rfc3339(time.Now().UTC())
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO people (id, name, created_at, updated_at)
		VALUES (?, ?, ?, ?)`, id, name, now, now)
	if err != nil {
		return nil, fmt.Errorf("create person: %w", err)
	}
	return &Person{ID: id, Name: name, CreatedAt: time.Now().UTC()}, nil
}

// RenamePerson updates a person's display name.
func (s *FaceStore) RenamePerson(ctx context.Context, id, name string) error {
	now := rfc3339(time.Now().UTC())
	res, err := s.db.ExecContext(ctx,
		`UPDATE people SET name = ?, updated_at = ? WHERE id = ?`, name, now, id)
	if err != nil {
		return fmt.Errorf("rename person: %w", err)
	}
	return ensureAffected(res, "person")
}

// SetCover writes which face ("derived") backs a person's cover thumbnail.
func (s *FaceStore) SetCover(ctx context.Context, personID, faceID string) error {
	f, err := s.FaceByID(ctx, faceID)
	if err != nil {
		return err
	}
	if f == nil || f.ID == "" {
		return fmt.Errorf("face %q not found", faceID)
	}
	now := rfc3339(time.Now().UTC())
	res, err := s.db.ExecContext(ctx,
		`UPDATE people SET cover_face_id = ?, cover_file_id = ?, updated_at = ?
		 WHERE id = ?`, faceID, f.FileID, now, personID)
	if err != nil {
		return fmt.Errorf("set cover: %w", err)
	}
	return ensureAffected(res, "person")
}

// DeletePerson removes a person and their assignments (faces are kept).
func (s *FaceStore) DeletePerson(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM people WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete person: %w", err)
	}
	return ensureAffected(res, "person")
}

// Merge moves every face of source into person keep, preserving each
// assignment's provenance (manual wins when a face somehow appears twice),
// adopts source's cover when the target lacks one, and deletes source.
func (s *FaceStore) Merge(ctx context.Context, keepID, sourceID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("merge begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, `
		SELECT face_id, assigned_by FROM person_faces WHERE person_id = ?`, sourceID)
	if err != nil {
		return fmt.Errorf("merge list: %w", err)
	}
	type mv struct{ faceID, by string }
	var moves []mv
	for rows.Next() {
		var m mv
		if err := rows.Scan(&m.faceID, &m.by); err != nil {
			_ = rows.Close()
			return fmt.Errorf("merge scan: %w", err)
		}
		moves = append(moves, m)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("merge rows: %w", err)
	}

	for _, m := range moves {
		by := m.by
		var existing string
		err := tx.QueryRowContext(ctx,
			`SELECT assigned_by FROM person_faces WHERE person_id = ? AND face_id = ?`,
			keepID, m.faceID).Scan(&existing)
		switch {
		case err == sql.ErrNoRows:
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO person_faces (person_id, face_id, assigned_by, created_at)
				 VALUES (?, ?, ?, ?)`, keepID, m.faceID, by, rfc3339(time.Now().UTC())); err != nil {
				return fmt.Errorf("merge insert: %w", err)
			}
		case err != nil:
			return fmt.Errorf("merge probe: %w", err)
		case existing == "auto" && by == "manual":
			if _, err := tx.ExecContext(ctx,
				`DELETE FROM person_faces WHERE person_id = ? AND face_id = ?`,
				keepID, m.faceID); err != nil {
				return fmt.Errorf("merge delete clash: %w", err)
			}
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO person_faces (person_id, face_id, assigned_by, created_at)
				 VALUES (?, ?, ?, ?)`, keepID, m.faceID, by, rfc3339(time.Now().UTC())); err != nil {
				return fmt.Errorf("merge insert manual: %w", err)
			}
		}
	}

	// Adopt the source cover when the target has none.
	var hasCover string
	err = tx.QueryRowContext(ctx,
		`SELECT COALESCE(cover_face_id, '') FROM people WHERE id = ?`, keepID).Scan(&hasCover)
	if err != nil {
		return fmt.Errorf("merge cover probe: %w", err)
	}
	if hasCover == "" {
		if _, err := tx.ExecContext(ctx, `
			UPDATE people SET cover_face_id = (SELECT cover_face_id FROM people WHERE id = ?),
			                  cover_file_id = (SELECT cover_file_id FROM people WHERE id = ?),
			                  updated_at = ?
			WHERE id = ?`, sourceID, sourceID, rfc3339(time.Now().UTC()), keepID); err != nil {
			return fmt.Errorf("merge cover: %w", err)
		}
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM people WHERE id = ?`, sourceID); err != nil {
		return fmt.Errorf("merge delete source: %w", err)
	}
	return tx.Commit()
}

// AssignPerson assigns a face to a person. A face belongs to at most one
// person; assigning it elsewhere moves it first. assignedBy is 'auto' or
// 'manual' and is stored verbatim.
func (s *FaceStore) AssignPerson(ctx context.Context, personID, faceID, assignedBy string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("assign begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx,
		`DELETE FROM person_faces WHERE face_id = ? AND person_id <> ?`, faceID, personID)
	if err != nil {
		return fmt.Errorf("assign unlink: %w", err)
	}
	if n, _ := res.RowsAffected(); n > 0 {
		// Moved a manually assigned face: keep it manual so the user's intent
		// survives.
		assignedBy = "manual"
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO person_faces (person_id, face_id, assigned_by, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(person_id, face_id) DO UPDATE SET assigned_by = excluded.assigned_by`,
		personID, faceID, assignedBy, rfc3339(time.Now().UTC())); err != nil {
		return fmt.Errorf("assign insert: %w", err)
	}
	return tx.Commit()
}

// UnassignPerson removes a face from a person (it becomes cluster-eligible).
func (s *FaceStore) UnassignPerson(ctx context.Context, personID, faceID string) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM person_faces WHERE person_id = ? AND face_id = ?`, personID, faceID)
	if err != nil {
		return fmt.Errorf("unassign face: %w", err)
	}
	return ensureAffected(res, "assignment")
}

// PurgeFaces deletes every face observation and assignment, leaving people
// (names, and any manual curation) intact. Covers are dropped via
// ON DELETE SET NULL. Returns the number of faces removed.
func (s *FaceStore) PurgeFaces(ctx context.Context) (int, error) {
	n, err := s.CountFaces(ctx)
	if err != nil {
		return 0, err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM faces`); err != nil {
		return 0, fmt.Errorf("purge faces: %w", err)
	}
	// Person faces cascade with the faces above; empty them defensively too.
	if _, err := s.db.ExecContext(ctx, `DELETE FROM person_faces`); err != nil {
		return 0, fmt.Errorf("purge assignments: %w", err)
	}
	return n, nil
}

// Float32 BLOB helpers -----------------------------------------------------

func float32Bytes(v []float32) ([]byte, error) {
	out := make([]byte, len(v)*4)
	for i, f := range v {
		binary.LittleEndian.PutUint32(out[i*4:], math.Float32bits(f))
	}
	return out, nil
}

func float32FromBytes(b []byte) ([]float32, error) {
	if len(b)%4 != 0 {
		return nil, fmt.Errorf("descriptor blob length %d not multiple of 4", len(b))
	}
	out := make([]float32, len(b)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return out, nil
}

// scanDescriptor reads the descriptor column into f, expects it to be the
// final scanned column after the Time fields (callers use custom Scan).
// scanFaceFull scans the shared 13-column face+rel_path row layout used by
// FacesUnassigned and PersonFaces: id, file_id, provider, version, x, y,
// width, height, confidence, descriptor, created_at, updated_at, rel_path.
func scanFaceFull(rows *sql.Rows) (FaceRecord, error) {
	var (
		f                            FaceRecord
		descriptor, created, updated string
	)
	err := rows.Scan(&f.ID, &f.FileID, &f.Provider, &f.Version,
		&f.Box.X, &f.Box.Y, &f.Box.Width, &f.Box.Height, &f.Box.Confidence,
		&descriptor, &created, &updated, &f.RelPath)
	if err != nil {
		return FaceRecord{}, fmt.Errorf("scan face: %w", err)
	}
	desc, err := float32FromBytes([]byte(descriptor))
	if err != nil {
		return FaceRecord{}, err
	}
	f.Descriptor = desc
	if err := parseTime(created, &f.CreatedAt); err != nil {
		return FaceRecord{}, err
	}
	if err := parseTime(updated, &f.UpdatedAt); err != nil {
		return FaceRecord{}, err
	}
	return f, nil
}

// newID returns a random lowercase-hex id (32 digits) using the same scheme
// as other Cairn entities.
func newID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generating id: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// ErrPersonNotFound is returned when a person does not exist.
var ErrPersonNotFound = errors.New("person not found")

func ensureAffected(res sql.Result, what string) error {
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	if n == 0 {
		return ErrPersonNotFound
	}
	return nil
}
