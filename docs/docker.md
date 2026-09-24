# Docker

Cairn ships as a single multi-stage container image: the React frontend and the
Go server are built in separate stages and the final image contains only one
statically linked binary.

## Build locally

```sh
docker build -t cairn .
```

The image defaults to listening on `:8715` and stores data in `/data`. The
container runs as an unprivileged user (`cairn`), and `/data` is writable by
that user. Build metadata can be injected with build args:

```sh
docker build \
  --build-arg VERSION=1.0.0 \
  --build-arg COMMIT=$(git rev-parse --short HEAD) \
  --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t cairn .
```

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

- `-v cairn-data:/data` persists server data (the server database; schema
  migrations apply automatically on startup). The library metadata lives inside
  each library directory, not here.
- `-e CAIRN_HTTP_ADDR=:8715` makes the container bind all interfaces inside the
  container's network namespace; the `-p` mapping controls exposure.
- To reach a library on the host, mount it read-only into the container and
  register it by its in-container path at runtime:

  ```sh
  docker run -d --name cairn -p 8715:8715 \
    -v cairn-data:/data \
    -v /mnt/photos:/libraries/photos:ro \
    cairn
  ```

  (Mounts are read-only; media content is never written back to the library.)

Behind a TLS-terminating reverse proxy, set `CAIRN_COOKIE_SECURE=true` so the
session cookie is only sent over HTTPS.

## Health checks

The image ships a `HEALTHCHECK` that hits `GET /api/v1/ready` — readiness — so
Docker stops routing to a container that is starting, degraded, or draining.
`GET /api/v1/health` (liveness) is still available for manual probing.

## Multi-arch builds

```sh
make docker-buildx   # uses CAIRN_PLATFORMS, default: linux/amd64,linux/arm64
```

Cross-arch note: because the image uses the pure-Go SQLite driver, no QEMU/CGO
emulation pitfalls apply to the database layer. For running on a Raspberry Pi,
see [raspberry-pi.md](raspberry-pi.md).