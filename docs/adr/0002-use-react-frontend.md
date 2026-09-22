# 0002 — Use a React + TypeScript frontend

- Status: accepted
- Date: 2026-09-22

## Context

Cairn's UI must feel personal, calm, and tactile while remaining information
dense, responsive across desktop/tablet/mobile, and accessible. The frontend
must be a pure client of the HTTP API so that native clients can be built later
without sharing UI code.

## Decision

The frontend is React with TypeScript, built with Vite. Client-side routing uses
react-router. Testing uses Vitest with Testing Library. No component library or
CSS framework is adopted up front; the Cairn visual system is implemented with
CSS custom properties (design tokens) defined in `web/src/styles/tokens.css`.

## Consequences

- TypeScript gives confident refactoring as the API surface grows.
- Vite keeps development hot-reload fast and output small enough for the
  embedded single binary.
- The visual identity lives in one token layer, easily revisited.
- New UI dependencies require a concrete requirement first (no "add for later").