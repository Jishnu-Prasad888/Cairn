# 0001 — Use a Go backend

- Status: accepted
- Date: 2026-09-22

## Context

Cairn needs to run on low-resource hardware (Raspberry Pi ARM64), serve large
libraries incrementally, stream media, and be packaged as a single small binary.
The backend will eventually include local ML integration, background job
processing, and filesystem access.

## Decision

The backend is written in Go. We use the standard library where it is
sufficient, `database/sql` for persistence, and explicit constructor-injected
dependencies. `net/http`'s `ServeMux` (Go 1.22+) is the router; no web framework
is introduced until a concrete need appears.

## Consequences

- Small static binaries and low memory overhead suit the target hardware.
- Strong typing and explicit dependencies keep package boundaries testable.
- A pure-Go SQLite driver (ADR-0003) keeps cross-compilation CGO-free.
- The team must write idiomatic Go: no hidden globals, thin handlers, small
  interfaces.