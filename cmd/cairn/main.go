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

	"github.com/Jishnu-Prasad888/Cairn/internal/config"
	"github.com/Jishnu-Prasad888/Cairn/internal/db"
	"github.com/Jishnu-Prasad888/Cairn/internal/httpapi"
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

	// Frontend: the embedded build by default, an on-disk build in development.
	webHandler, err := webui.Handler(cfg.WebDistDir)
	if err != nil {
		logger.Warn("frontend unavailable", "error", err)
		webHandler = nil
	}

	api := httpapi.New(httpapi.Dependencies{
		Logger: logger,
		DB:     pool,
		WebUI:  webHandler,
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
