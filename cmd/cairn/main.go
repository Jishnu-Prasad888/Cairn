// Command cairn runs the Cairn server: the JSON API, background workers, and
// the embedded web frontend, in a single process.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/audit"
	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/authz"
	"github.com/Jishnu-Prasad888/Cairn/internal/backups"
	"github.com/Jishnu-Prasad888/Cairn/internal/config"
	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/db"
	"github.com/Jishnu-Prasad888/Cairn/internal/httpapi"
	"github.com/Jishnu-Prasad888/Cairn/internal/indexer"
	"github.com/Jishnu-Prasad888/Cairn/internal/library"
	"github.com/Jishnu-Prasad888/Cairn/internal/logging"
	"github.com/Jishnu-Prasad888/Cairn/internal/metadata"
	"github.com/Jishnu-Prasad888/Cairn/internal/metrics"
	"github.com/Jishnu-Prasad888/Cairn/internal/ml"
	"github.com/Jishnu-Prasad888/Cairn/internal/version"
	"github.com/Jishnu-Prasad888/Cairn/internal/webui"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "cairn:", err)
		os.Exit(1)
	}
}

// run wires the application together and blocks until the server shuts down.
// It is separated from main so shutdown paths can be exercised and so logging
// stays off stdout.
func run() error {
	cfg := config.Load()
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}

	logger := logging.New(cfg.LogLevel)
	info := version.Get()
	logger.Info("starting cairn",
		"version", info.Version,
		"commit", info.Commit,
		"build_date", info.BuildDate,
		"go_version", info.GoVersion,
		"platform", info.Platform,
		"data_dir", cfg.DataDir,
		"http_addr", cfg.HTTPAddr,
	)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Server-level database.
	pool, err := db.Open(cfg.DatabasePath())
	if err != nil {
		return err
	}
	defer func() { _ = pool.Close() }()

	if err := db.Migrate(pool); err != nil {
		return fmt.Errorf("apply database migrations: %w", err)
	}

	// Audit and authentication from the server database.
	auditSvc := audit.New(pool, logger)
	authSvc := auth.NewService(pool, logger, auditSvc)
	pruneCtx, cancelPrune := context.WithTimeout(ctx, 15*time.Second)
	if err := authSvc.PruneExpired(pruneCtx, time.Now().UTC()); err != nil {
		cancelPrune()
		return err
	}
	cancelPrune()

	// Resource-based authorization (ADR-0005): grants and public shares over
	// registered libraries. Backed by the server database and audit log.
	authzSvc := authz.NewService(pool, logger, auditSvc)

	// Registered storage libraries; reconcile connectivity at startup so a
	// disconnected disk is surfaced as offline immediately.
	keys := crypto.NewKeys(cfg.EncryptionPassphrase)
	if keys.Enabled() {
		logger.Info("at-rest metadata encryption enabled")
	}
	libraries := library.NewManager(pool, logger, auditSvc, keys)
	refreshCtx, cancelRefresh := context.WithTimeout(ctx, 15*time.Second)
	if err := libraries.RefreshAll(refreshCtx); err != nil {
		cancelRefresh()
		return err
	}
	cancelRefresh()

	// Incremental indexer: manages per-library scan jobs. Each library gets a
	// background job worker (index scans + media processing) once it is
	// registered; workers for already-registered libraries are started below.
	idxManager := indexer.NewIndexManager(logger)
	idxManager.SetBaseContext(ctx)
	mediaProc := metadata.NewProcessor(logger, keys)
	idxManager.SetMediaProcessor(mediaProc)

	// Recover persisted scan and media-processing jobs after a restart:
	// start one job worker per registered library. Offline libraries are
	// skipped and gain their worker on the next index trigger.
	if libs, err := libraries.List(ctx); err == nil {
		idxManager.StartWorkers(ctx, libs)
	} else {
		logger.Warn("list libraries for job workers", "error", err)
	}

	// Local ML: optional similarity signatures. The manager is inert unless
	// CAIRN_ML_ENABLED is set; similarity passes run after index scans and on
	// explicit API calls.
	mlManager := ml.NewManager(logger, ml.Config{
		Enabled:           cfg.MLEnabled,
		Workers:           cfg.MLWorkers,
		DistanceThreshold: cfg.MLDistanceThreshold,
	}, ml.AverageHashProvider{})
	faces := ml.NewFaceManager(logger, ml.FaceConfig{
		Enabled:       cfg.MLEnabled && cfg.MLFaces,
		Workers:       cfg.MLFaceWorkers,
		MinConfidence: cfg.MLFaceMinConfidence,
		MinSize:       cfg.MLFaceMinSize,
		Threshold:     cfg.MLFaceThreshold,
	}, nil)
	{
		after := func(libraryID, root string) {
			if cfg.MLSimilarity {
				if _, err := mlManager.Pass(context.Background(), libraryID, root); err != nil {
					logger.Warn("similarity pass after index", "library_id", libraryID, "error", err)
				}
			}
			if faces.Enabled() {
				if _, err := faces.Pass(context.Background(), root); err != nil {
					logger.Warn("face pass after index", "library_id", libraryID, "error", err)
				}
			}
		}
		if (cfg.MLEnabled && cfg.MLSimilarity) || faces.Enabled() {
			idxManager.AfterScan = after
		}
	}

	// Backups: one-shot, scheduled, and restore operations over the server
	// database and every registered library. The scheduler is a no-op when no
	// backup directory is configured.
	backupMgr := backups.NewManager(pool, logger, libraries, backups.Config{
		Dir:        cfg.BackupDir,
		Keep:       cfg.BackupKeep,
		Passphrase: cfg.BackupPassphrase,
		Interval:   time.Duration(cfg.BackupIntervalMinutes) * time.Minute,
	}, cfg.DatabasePath())
	backupMgr.Start(ctx)

	// Frontend: the embedded build by default, an on-disk build in development.
	webHandler, err := webui.Handler(cfg.WebDistDir)
	if err != nil {
		logger.Warn("frontend unavailable", "error", err)
		webHandler = nil
	}

	api := httpapi.New(httpapi.Dependencies{
		Logger:         logger,
		DB:             pool,
		Auth:           authSvc,
		Authz:          authzSvc,
		Libraries:      libraries,
		Indexer:        idxManager,
		ML:             mlManager,
		Faces:          faces,
		Backups:        backupMgr,
		Keys:           keys,
		SecureCookies:  cfg.CookieSecure,
		MaxUploadBytes: cfg.MaxUploadBytes,
		WebUI:          webHandler,
		Metrics:        metrics.New(),
	})

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("http server listening", "addr", cfg.HTTPAddr)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("http server: %w", err)
		}
		return nil
	case <-ctx.Done():
		logger.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// Flip /ready to 503 before draining so proxies and orchestrators stop
	// sending new traffic while in-flight requests finish.
	api.MarkNotReady()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	logger.Info("server stopped")
	return nil
}
