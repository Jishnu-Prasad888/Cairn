# Deployment

Recommended production deployment for the current phase. For first-time
installations (downloading the binary, systemd service, upgrades) see
[installation.md](installation.md).

## Minimum viable deployment

```sh
make build          # or download a release binary — see installation.md
./bin/cairn
```

The server binds to `127.0.0.1:8715` by default. For access beyond localhost,
expose it through a reverse proxy; the server is designed to be deployed
**behind a TLS reverse proxy** (Caddy, nginx, Traefik, or a cloud load balancer)
rather than terminating TLS itself.

## Reverse proxy sample (Caddy)

```text
cairn.example.com {
    reverse_proxy 127.0.0.1:8715
}
```

Caddy obtains certificates automatically once the domain resolves.

## Reverse proxy sample (nginx)

```nginx
server {
    listen 443 ssl;
    server_name cairn.example.com;

    ssl_certificate     /etc/ssl/cairn.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/cairn.example.com/privkey.pem;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:8715;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Set `client_max_body_size` to at least your largest expected upload (the server
default upload cap is 2 GiB; tune `CAIRN_MAX_UPLOAD_BYTES` to match).

## Probes

- `GET /api/v1/health` — liveness: is the process alive? Returns 200 even when
  the database is down (body says `degraded`) so orchestrators do not restart a
  server that can still recover. Suitable for container `HEALTHCHECK`.
- `GET /api/v1/ready` — readiness: should traffic be routed here? 200 only when
  started, database reachable, and not draining; 503 during startup, database
  failure, and graceful shutdown. Use this for load-balancer and
  orchestrator routing decisions.
- `GET /api/v1/metrics` — Prometheus-text metrics; see [installation.md](installation.md).

## Notes

- The default `127.0.0.1` bind is intentional. Deploy behind a reverse proxy
  that terminates TLS; authentication (built-in accounts) protects the API, but
  credentials should never travel over plain HTTP.
- Preserve the data directory (`CAIRN_DATA_DIR`) across upgrades — it holds the
  server database, which is migrated automatically on startup. Never run two
  server processes against the same data directory.
- For Docker, see [docker.md](docker.md). Raspberry Pi specifics in
  [raspberry-pi.md](raspberry-pi.md). OS-level hardening in
  [security.md](security.md).