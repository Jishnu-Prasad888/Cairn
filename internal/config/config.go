// Package config loads Cairn server configuration from the environment.
//
// Configuration is intentionally environment-driven. A single self-hosted
// process should not require a config file to run; advanced options can be
// added later without breaking the base contract.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// EnvPrefix is the prefix used for all Cairn environment variables.
	EnvPrefix = "CAIRN"

	// DefaultHTTPAddr is the default listen address.
	DefaultHTTPAddr = "127.0.0.1:8715"

	// DefaultLogLevel is the default log verbosity.
	DefaultLogLevel = "info"
)

// Config holds the runtime configuration for the Cairn server process.
type Config struct {
	// HTTPAddr is the listen address for the HTTP/JSON API and web UI.
	HTTPAddr string

	// DataDir is the server-level data directory. It holds the server
	// database and other server-scoped state. Library metadata lives inside
	// each library, never here.
	DataDir string

	// LogLevel is one of debug, info, warn, error.
	LogLevel string

	// WebDistDir overrides the embedded frontend with a directory of built
	// static assets. Empty means "use the embedded frontend". Useful for
	// development and for embedding tools that cannot use go:embed.
	WebDistDir string
}

// Load builds a Config from the process environment and platform defaults.
//
// Cairn settings follow the CAIRN_<NAME> naming scheme, e.g. CAIRN_HTTP_ADDR,
// CAIRN_DATA_DIR. Standard platform variables (XDG_DATA_HOME, HOME) are
// honored for the default data directory.
func Load() Config {
	return Config{
		HTTPAddr:   envOrDefault("HTTP_ADDR", DefaultHTTPAddr),
		DataDir:    dataDir(),
		LogLevel:   envOrDefaultTrim("LOG_LEVEL", DefaultLogLevel),
		WebDistDir: envOrDefaultTrim("WEB_DIST", ""),
	}
}

// Validate returns an error if the configuration is not usable.
func (c Config) Validate() error {
	if c.HTTPAddr == "" {
		return errors.New("HTTPAddr must not be empty")
	}
	if c.DataDir == "" {
		return errors.New("DataDir must not be empty")
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("invalid LogLevel %q: must be one of debug, info, warn, error", c.LogLevel)
	}
	return nil
}

// DatabasePath returns the path of the server-level SQLite database file.
func (c Config) DatabasePath() string {
	return filepath.Join(c.DataDir, "cairn.db")
}

// dataDir resolves the default data directory, honoring the CAIRN_DATA_DIR
// environment variable, then XDG_DATA_HOME and HOME on Unix-like systems. It
// returns a relative fallback only as a last resort so that unrelated files
// are never created in the working tree.
func dataDir() string {
	if v := envOrDefaultTrim("DATA_DIR", ""); v != "" {
		return v
	}

	if xdg := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); xdg != "" {
		return filepath.Join(xdg, "cairn")
	}

	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		return filepath.Join(home, ".local", "share", "cairn")
	}

	return filepath.Join("cairn-data")
}

// envOrDefault returns the value of the CAIRN_<name> environment variable or
// the given default. Whitespace is preserved.
func envOrDefault(name, def string) string {
	if v, ok := os.LookupEnv(EnvPrefix + "_" + name); ok && v != "" {
		return v
	}
	return def
}

// envOrDefaultTrim is like envOrDefault but trims surrounding whitespace.
func envOrDefaultTrim(name, def string) string {
	if v, ok := os.LookupEnv(EnvPrefix + "_" + name); ok {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return def
}