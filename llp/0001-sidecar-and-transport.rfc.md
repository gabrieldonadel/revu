# LLP 0001: Sidecar split, transport, polling, and state

**Type:** RFC
**Status:** Accepted
**Systems:** App, Sidecar, GitHub
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-28
**Revised:** 2026-09-28 (r1)
**Related:** LLP 0000, LLP 0002, LLP 0003, expo/exact LLP 0570

## Summary

revu runs as an Exact app plus a Bun sidecar daemon. The app cannot spawn
processes, so anything that needs `git`, the Claude Agent SDK, or a long-lived
poller lives in the sidecar. The two talk over loopback HTTP and a WebSocket.

## Sidecar split

Exact's JS surface has no subprocess API. The AI review needs `git` worktrees
and an agent runtime; GitHub polling should outlive the window. Both belong in
an ordinary Bun process. The app stays a thin native shell: tray, windows,
notifications, Keychain.

A change that moves polling into the app, or makes the sidecar own the token,
breaks this design. Keep the boundary: the app owns secrets and UI; the
sidecar owns work and state.

## Transport

Requests are plain HTTP on `127.0.0.1` (`/health`, `/prs`, `/auth/*`,
`/poll`, `/prs/:id/seen`). Pushes are one WebSocket at `/events` that sends a
full `snapshot` on connect and after every poll, plus one `review_requested`
event per newly seen pull request. The app treats `snapshot` as truth and
`review_requested` as the notification trigger only.

The sidecar binds loopback only. It is not a network service.

## Polling

Polling, not webhooks: a local app must not need a public URL. Two GitHub
calls do the work:

1. `GET /notifications?participating=true` with `If-Modified-Since` — the
   cheap incremental signal. A 304 costs no rate limit. `reason ==
   review_requested` rows carry the real `requested_at`. Honour
   `X-Poll-Interval`.
2. `GET /search/issues?q=is:open is:pr review-requested:@me` — the full
   refresh that reconciles closes and merges and catches requests that
   predate the daemon. Search has a lower rate limit, so it runs on every
   fifth poll.

On any failure the next poll backs off (4× the configured interval, capped at
10 minutes).

## State

SQLite at `~/Library/Application Support/revu/state.db`. It holds every pull
request the sidecar has seen with `first_seen_at` and `seen`. "New since last
check" is defined as "not in the table", which is what makes it survive
restarts and what makes a notification fire exactly once.

## Configuration

One file, `revu.config.json` at the repo root: the OAuth client id (not a
secret), the requested scopes, the poll interval, and the sidecar port. No
secrets live in it or anywhere else on disk; see LLP 0002.

## Open questions

- Sidecar lifecycle: `launchd` LaunchAgent with `KeepAlive` for the packaged
  app; `bun run sidecar:dev` during development. Not built yet.
