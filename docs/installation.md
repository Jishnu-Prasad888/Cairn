# Installation

Cairn ships as a single self-contained binary with the web frontend embedded.
There are no runtime dependencies: the binary is statically linked, uses the
pure-Go SQLite driver, and needs only a writable data directory. SQLite is
embedded — no external database server is required.

## Requirements

| Platform     | Architectures      | Notes                                   |
| ------------ | ------------------ | --------------------------------------- |
| Linux        | `amd64`, `arm64`   | Static binary; runs on Raspberry Pi     |
| macOS        | `amd64`, `arm64`   | Intel and Apple Silicon                 |
| Windows      | `amd64`            | Build from source; no service wrapper   |

A 64-bit CPU is assumed. The binary needs no shared libraries
(`CGO_ENABLED=0`).

## Option 1: Download a release binary

1. Download the archive for your platform from the [Releases] page
   (`cairn-linux-amd64`, `cairn-linux-arm64`, `cairn-darwin-amd64`,
   `cairn-darwin-arm64`, `cairn-windows-amd64.exe`).
2. Verify the SHA-256 checksum against the `SHA256SUMS` file shipped with the
   release:

   ```sh
   shasum -a 256 -c SHA256SUMS
   ```

3. Make it executable and place it somewhere on `PATH`:

   ```sh
   chmod +x cairn-linux-amd64
   sudo mv cairn-linux-amd64 /usr/local/bin/cairn
   ```

4. Run it:

   ```sh
   cairn
   ```

   The server listens on `127.0.0.1:8715` by default. Open
   `http://127.0.0.1:8715` — on first run you are guided through creating the
   initial admin account (bootstrapping).

## Option 2: Build from source

Requires Go 1.26+ and Node 22+ (the frontend is built once and embedded).

```sh
make build          # builds the web frontend, then the single binary
./bin/cairn
```

Use `make release` to produce binaries for every supported platform in `dist/`
(see `make release PLATFORMS="linux/amd64 linux/arm64"` to limit targets).

## First run

1. Start the server. By default data is stored in `~/.cairn`; override with
   `CAIRN_DATA_DIR` (e.g. `/var/lib/cairn`).
2. Visit `http://127.0.0.1:8715`. If no admin account exists, the app shows the
   bootstrap screen: create the first account (username + password, minimum 8
   characters, argon2id-hashed). This only works while no users exist — for
   security it cannot be re-run.
3. Register your photo/video libraries under **Settings → Libraries**. Library
   metadata is stored *inside* each library directory; the server never writes
   to your media files.

## Running as a service (systemd, Linux)

Create `/etc/systemd/system/cairn.service`:

```ini
[Unit]
Description=Cairn media server
After=network.target

[Service]
Type=simple
User=cairn
Group=cairn
Environment=CAIRN_DATA_DIR=/var/lib/cairn
Environment=CAIRN_HTTP_ADDR=127.0.0.1:8715
ExecStart=/usr/local/bin/cairn
Restart=on-failure
RestartSec=5
# Hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cairn
```

For access beyond localhost, put a TLS-terminating reverse proxy in front (see
[deployment.md](deployment.md)) rather than exposing the port directly.

## Configuration

Cairn is configured through environment variables (prefixed `CAIRN_`); there is
no config file. The most common ones:

| Variable                    | Default          | Purpose                                        |
| --------------------------- | ---------------- | ---------------------------------------------- |
| `CAIRN_DATA_DIR`            | `~/.cairn`       | Server data directory (database lives here)    |
| `CAIRN_HTTP_ADDR`           | `127.0.0.1:8715` | Listen address                                 |
| `CAIRN_LOG_LEVEL`           | `info`           | `debug`, `info`, `warn`, or `error`            |
| `CAIRN_COOKIE_SECURE`       | `false`          | Always send the session cookie over HTTPS only |
| `CAIRN_MAX_UPLOAD_BYTES`    | `2 GiB`          | Upload size cap                                |
| `CAIRN_WEB_DIST`            | (embedded)       | Override the frontend with on-disk assets      |

## Upgrades

1. Stop the service: `sudo systemctl stop cairn`.
2. Replace the binary (download the new release, verify the checksum, move it
   into place).
3. Start the service again: `sudo systemctl start cairn`.

Schema migrations run automatically on startup, in both the server database and
each library database. Preserve `CAIRN_DATA_DIR` and your library directories —
they hold all of your data. Downgrades are not supported: if you need to roll
back, restore from your [backups](backups.md).

## Docker

A multi-arch container image is the alternative to a native binary — see
[docker.md](docker.md).

## Operational endpoints

| Endpoint               | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `GET /api/v1/health`   | Liveness probe (200 even when degraded)                    |
| `GET /api/v1/ready`    | Readiness probe (503 while starting/draining/degraded)     |
| `GET /api/v1/version`  | Build metadata (`version`, `commit`, `build_date`, …)      |
| `GET /api/v1/metrics`  | Prometheus-text metrics (no scraping agent required)       |

Point Prometheus (or Grafana Agent) at `/api/v1/metrics` with e.g.:

```yaml
scrape_configs:
  - job_name: cairn
    static_configs:
      - targets: ["127.0.0.1:8715"]
    metrics_path: /api/v1/metrics
```

The endpoint exposes operational counters only — request counts, latency
distribution, in-flight requests, process uptime, and Go runtime gauges — never
file or library content. It can be firewalled or reverse-proxied to an internal
network if you prefer not to expose it.

## Troubleshooting

- **"permission denied" opening the database** — the data directory must be
  writable by the user running the server.
- **500 on startup** — check `CAIRN_DATA_DIR` is on a filesystem supporting
  proper file locking and that only one server instance points at it.
- See [troubleshooting.md](troubleshooting.md) and
  [raspberry-pi.md](raspberry-pi.md) for more.

[Releases]: https://github.com/Jishnu-Prasad888/Cairn/releases