# revu

A macOS app for reviewing GitHub pull requests, built on
[Exact2](https://github.com/ccheever/exact2) with an
[LLP](https://github.com/ccheever/llp) design corpus in `llp/`.

- **`revu-app/`** — the Exact2 app (`app.contract` UI, `app.ts` data: device-flow
  sign-in, GitHub polling, Keychain token, SQLite seen-state). Windowed; the
  menu bar item and notifications are capability asks (LLP 0003).
- **`sidecar/`** — Bun daemon for the AI-review runner (M5).

## Run

Requires a sibling `../exact2` checkout and its prerequisites (Bun 1.4.2,
Rust 1.97, the vanilla Hermes engine built by a sibling `../ibex`).

```sh
bun run app:web      # the web dev loop
bun run app:mac      # build and launch the bare host binary (fast loop; no bundle identity)
bun run app:bundle   # build revu.app — needed for notifications (bundle identity)
bun run app:open     # launch the built revu.app
```

Notifications need bundle identity, so test them from `revu.app`, not the
bare binary `app:mac` launches. Each identity keeps its own Keychain token.

Sign in from the window (device flow, LLP 0002). Config: `revu.config.json`.
