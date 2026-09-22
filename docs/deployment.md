# Deployment

Recommended production deployment at the project's current phase.

## Minimum viable deployment

```sh
make build
./bin/cairn
```

The server binds to `127.0.0.1:8715` by default. For access beyond localhost,
expose it through a reverse proxy; the server is designed to be deployed
**behind a TLS reverse proxy** (Caddy, nginx, Traefik, or a cloud load balancer)
rather than terminating TLS itself at this phase.

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

Set `client_max_body_size` according to your expected upload sizes (media bulk
upload arrives in a later phase).

## Notes

- The default `127.0.0.1` bind is intentional: do not expose Cairn to a public
  interface until authentication exists (Phase 1).
- Authentication is not yet implemented; the API is unauthenticated in Phase 0.
- For Docker, see [docker.md](docker.md). Raspberry Pi specifics in
  [raspberry-pi.md](raspberry-pi.md). OS-level hardening in [security.md](security.md).