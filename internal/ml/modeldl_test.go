package ml

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func waitModel(t *testing.T, d *ModelDownloader) ModelStatus {
	t.Helper()
	for i := 0; i < 3000; i++ {
		st := d.Status()
		if st.State == ModelDone || st.State == ModelFailed {
			return st
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("download did not finish")
	return ModelStatus{}
}

func TestModelDownloadRejectsGarbageAndKeepsNothing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("definitely not an onnx model"))
	}))
	defer srv.Close()
	path := filepath.Join(t.TempDir(), "models", "m.onnx")
	d := NewModelDownloader(slog.New(slog.NewTextHandler(io.Discard, nil)), path, srv.URL, 60, 0.1, nil)
	if d.Installed() {
		t.Fatal("installed before download")
	}
	d.Start()
	if st := waitModel(t, d); st.State != ModelFailed || st.Error == "" {
		t.Fatalf("want failure, got %+v", st)
	}
	if d.Installed() {
		t.Fatal("garbage was installed")
	}
	if _, err := os.Stat(path + ".part"); err == nil {
		t.Fatal("partial file left behind")
	}
}

func TestModelDownloadHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	d := NewModelDownloader(slog.New(slog.NewTextHandler(io.Discard, nil)),
		filepath.Join(t.TempDir(), "m.onnx"), srv.URL, 60, 0.1, nil)
	d.Start()
	if st := waitModel(t, d); st.State != ModelFailed {
		t.Fatalf("got %+v", st)
	}
}

func TestModelDownloadInstallsRealModel(t *testing.T) {
	src := os.Getenv("ONNX_MODEL")
	if src == "" {
		t.Skip("ONNX_MODEL not set")
	}
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(data)
	}))
	defer srv.Close()
	got := make(chan *EmbeddingFaceProvider, 1)
	d := NewModelDownloader(slog.New(slog.NewTextHandler(io.Discard, nil)),
		filepath.Join(t.TempDir(), "models", "m.onnx"), srv.URL, 60, 0.1,
		func(p *EmbeddingFaceProvider) { got <- p })
	d.Start()
	st := waitModel(t, d)
	if st.State != ModelDone || !st.Installed || st.Downloaded != int64(len(data)) {
		t.Fatalf("got %+v", st)
	}
	select {
	case <-got:
	case <-time.After(time.Second):
		t.Fatal("onReady not called")
	}
}
