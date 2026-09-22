# Docker

Cairn ships as a single multi-stage container image.

## Build locally

```sh
docker build -t cairn .
```

The image defaults to listening on `:8715` and stores data in `/data`. The
container runs as an unprivileged user (`cairn`), and `/data` is writable by
that user.

## Run

```sh
docker run -d \
  --name cairn \
  --restart unless-stopped \
  -p 8715:8715 \
  -v cairn-data:/data \
  -e CAIRN_HTTP_ADDR=:8715 \
  cairn
```

- `-v cairn-data:/data` persists server data (database and future server state).
- `-e CAIRN_HTTP_ADDR=:8715` makes the container bind all interfaces inside the
  container's network namespace; the `-p` mapping controls exposure.
- To reach a library on the host, mount it read-only into the container and
  register it from the host path at runtime:

  ```sh
  docker run -d --name cairn -p 8715:8715 \
    -v cairn-data:/data \
    -v /mnt/photos:/libraries/photos:ro \
    cairn
  ```

  (Currently informational: library registration arrives in a later phase.)

## Health check

The image ships a `HEALTHCHECK` that hits `GET /api/v1/health`. When running
behind a proxy, the default exposed port and path are consistent with the
server's built-in defaults.

## Multi-arch builds

```sh
make docker-buildx   # uses CAIRN_PLATFORMS, default: linux/amd64,linux/arm64
```

.Cross-arch note: because the image uses the pure-Go SQLite driver, no QEMU/CGO
emulation pitfalls apply to the database layer.