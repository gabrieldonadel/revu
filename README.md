# revu

A macOS menu bar app for reviewing GitHub pull requests, built on
[Exact](https://github.com/expo/exact) (Contract UI, AppKit host) with an
[LLP](https://github.com/ccheever/llp) design corpus in `llp/`.

Two processes (LLP 0001):

- **app** (`src/`) — tray item, native menu, window, notifications, Keychain.
- **sidecar** (`sidecar/`) — Bun daemon on `127.0.0.1:47831`: GitHub polling,
  SQLite state, later the AI review runner.

## Run (development)

```sh
bun install                      # links @exact/* from the checkout named in exact.links.json
bun run sidecar:dev              # terminal 1 — the daemon
EXACT_MAC_APP=/path/to/ExactAppMac.app bun run dev:mac   # terminal 2 — dev server + host
```

The host must be built from an Exact checkout that carries LLP 0570
(desktop notifications) — today that is PR expo/exact#79. `exact.links.json`
points at that checkout.

Sign in from the window (device flow, LLP 0002); the token goes to the
Keychain and is handed to the sidecar per session.

## Config

`revu.config.json` — OAuth client id (not a secret), scopes, poll interval,
sidecar port. No secrets on disk anywhere.

## Verify

```sh
bun run typecheck
bun run sidecar:typecheck
```
