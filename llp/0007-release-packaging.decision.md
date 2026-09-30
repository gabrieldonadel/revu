# LLP 0007: One zip a Mac can run

**Type:** Decision
**Status:** Active (first cut 2026-09-30, `v0.1.0-rc.1`)
**Systems:** App, Sidecar, Release
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-30
**Related:** LLP 0001 (the sidecar split), LLP 0002 r3 (the token's store), LLP 0004 (runners), LLP 0006 (the module)

## Decision

A release is `revu-<version>-macos-<arch>.zip` on GitHub Releases, made by
`scripts/package.sh`:

- `revu.app` from the Exact2 bundle build, with the sidecar **compiled into
  it**: `Contents/Resources/revu-sidecar` (`bun build --compile`), beside
  `skills/` and `revu.config.json`. The sidecar finds both next to its own
  executable (`bundleDir`); `~/.config/revu/skills` still shadows.
- **The app starts the sidecar** (LLP 1067 module, `Sidecar.startIfNeeded`):
  at load, if nothing answers on `127.0.0.1:47831`, it runs the packaged
  binary with `~/.local/bin`, `~/.bun/bin` and Homebrew on its PATH (the
  agent CLIs and `gh` live there) and logs to `~/Library/Logs/revu-sidecar.log`;
  it stops it when the app quits. A sidecar started by hand is left alone.
- **Ad-hoc signed.** There is no Developer ID on the build Mac. Gatekeeper
  shows "unidentified developer" on first open: right-click → Open once, or
  `xattr -d com.apple.quarantine revu.app`. Notarization is a later step
  with an Apple developer account; then the token moves back to the
  Keychain (LLP 0002 r3's flag).
- Apple Silicon only (`uname -m` names the zip); macOS 14+.

## What a user needs

`gh` (any login state: revu hands the agent its own token), and Claude Code
(`claude`, signed in) or the Codex CLI (`codex`, signed in). Nothing else;
no Bun, no Rust, no checkout of anything.

## Consequences

- The RC is a pre-release; the first-open warning is the cost of no
  identity. It is stated in the release notes.
- `scripts/package.sh` is the only path to a zip; the build's own receipt
  (`Contents/Resources/receipt.json`) stays inside the bundle.
- Codex is shipped untested (LLP 0004).
