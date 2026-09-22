# Raspberry Pi

Cairn targets low-resource ARM64 hardware (Raspberry Pi 4/5, NAS boxes).

## Constraints honored

- Single small binary, embedded frontend — no Node runtime on the device.
- Pure-Go SQLite driver — no CGO, straightforward `GOARCH=arm64` builds.
- Bounded background processing with concurrency limits (later phases).
- SQLite WAL read scaling suits single-process metadata access.

## Recommended OS

Raspberry Pi OS Lite or any 64-bit Linux (arm64). Avoid running the server as
root; use the `cairn` service user.

## Build for arm64 (from any machine)

```sh
GOOS=linux GOARCH=arm64 go build -o bin/cairn ./cmd/cairn
```

Or use the cross-build convenience:

```sh
make docker-buildx
```

## Systemd unit

```ini
[Unit]
Description=Cairn
After=network.target

[Service]
User=cairn
Group=cairn
ExecStart=/usr/local/bin/cairn
Environment=CAIRN_HTTP_ADDR=:8715
Environment=CAIRN_DATA_DIR=/var/lib/cairn
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Keep the data directory on the same disk layout you will register as a library
so metadata is near the originals (see [storage.md](storage.md)).

## Storage

Use an SSD or USB3-attached disk for libraries; avoid spinning disks as the
primary store for metadata databases if scans are heavy. Indexing runs
incrementally and respects low priority (nice value, I/O limits) in later
phases.