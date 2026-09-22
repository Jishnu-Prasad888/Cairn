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
	"github.com/Jishnu-Prasad888/Cairn/internal/config"
	"github.com/Jishnu-Prasad888/Cairn/internal/db"
	"github.com/Jishnu-Prasad888/Cairn/internal/httpapi"
	"github.com/Jishnu-Prasad888/Cairn/internal/indexer"
	"github.com/Jishnu-Prasad888/Cairn/internal/library"
	"github.com/Jishnu-Prasad888/Cairn/internal/logging"
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
	libraries := library.NewManager(pool, logger, auditSvc)
	refreshCtx, cancelRefresh := context.WithTimeout(ctx, 15*time.Second)
	if err := libraries.RefreshAll(refreshCtx); err != nil {
		cancelRefresh()
		return err
	}
	cancelRefresh()

	// Incremental indexer: manages per-library scan jobs.
	idxManager := indexer.NewIndexManager(logger)

	// Frontend: the embedded build by default, an on-disk build in development.
	webHandler, err := webui.Handler(cfg.WebDistDir)
	if err != nil {
		logger.Warn("frontend unavailable", "error", err)
		webHandler = nil
	}

	api := httpapi.New(httpapi.Dependencies{
		Logger:        logger,
		DB:            pool,
		Auth:          authSvc,
		Authz:         authzSvc,
		Libraries:     libraries,
		Indexer:       idxManager,
		SecureCookies: cfg.CookieSecure,
		WebUI:         webHandler,
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
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	logger.Info("server stopped")
	return nil
}
