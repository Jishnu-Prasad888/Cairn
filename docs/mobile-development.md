# Mobile development

Cairn's frontend is a pure client of the documented HTTP API
([api.md](api.md), [openapi.yaml](openapi.yaml)). The web app is the reference
client, but the API contract enables additional clients.

## Requirements for future native clients

- Compile against the OpenAPI document; the API version is in the URL and gaps
  are resolved by versioning — never by scraping HTML.
- Sessions use HTTP-only cookies (Phase 1); a native client stores its cookie
  securely and presents it with every request (a persistent
  `URLSessionCookieStorage` / platform-equivalent is sufficient — no custom
  token plumbing).
- Handle the error envelope on every request and surface `message` + `request_id`
  to users who file bug reports.
- Batch uploads/downloads through the documented streaming endpoints
  (`Content-Type` and cache rules are part of the contract).
- Respect `X-Request-ID` and pass it along for correlation.

## Packaging

- Community-maintained clients are welcome; they are not tied to the server's
  package versions because the API is the only coupling.

Mobile-specific conveniences (background upload, offline viewing of selected
albums) will be documented here once implemented.