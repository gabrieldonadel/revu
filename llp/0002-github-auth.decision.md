# LLP 0002: GitHub authentication is the OAuth device flow

**Type:** Decision
**Status:** Active
**Systems:** App, Sidecar, GitHub
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-28
**Related:** LLP 0001

## Decision

revu authenticates with the GitHub OAuth **device flow** against the OAuth App
"revu" (client id `Ov23li3weoDK9jZ4ycnp`, Device Flow enabled, "Expire user
access tokens" off). Scopes: `notifications`, `repo`, `read:user`.

## Device flow

The sidecar starts the flow (`POST /auth/device/start` → `user_code` +
`verification_uri`), the app shows the code, the user enters it on GitHub,
and the sidecar polls until GitHub returns the token. The token is returned
to the app **once**; the app stores it in the Keychain via
`desktop.secureStorage` and hands it back to the sidecar on every start with
`POST /auth/token`. The sidecar keeps it in memory only.

## Why

- No token pasting, revocable from GitHub Settings → Applications.
- `repo` is required for private-repository pull request details and search;
  the classic OAuth scope is coarse, and that is accepted for a personal tool.
- Expiring tokens were declined for now: refresh-token rotation is extra code
  and extra failure modes. It can be turned on later and the refresh path
  added without touching anything else.

## What would change this

A GitHub App with fine-grained permissions would narrow `repo`. It needs an
installation per organization, which is more setup than this tool wants today.

## Open question (2026-09-28)

On the real macOS host the first grant poll after a fresh device code once
answered `incorrect_device_code`; the next poll answered `authorization_pending`
and the flow continued. Under the agent driver (seekable clock from 0) every
poll is `pending`. Not yet explained; the app survives it. Investigate whether
the first tick can observe a stale `device` slot across the mutation's
`refreshes session`.

## Dev-loop note (2026-09-30)

On a machine with no Apple Development identity, every rebuild is ad-hoc
signed and macOS treats it as a new application: reading a Keychain item the
previous build wrote raises the "ExactMac wants to use your confidential
information" prompt, and because the store is read on every poll, one
denied prompt is followed by another. Two workable answers: install an
identity and set `EXACT_IDENTITY` so the ACL survives rebuilds, or delete the
app's items (`security delete-generic-password -s ExactMac` for the bare
binary, `-s dev.donadel.revu` for `revu.app`) and sign in
again after a rebuild. Worth raising with exact2 as a dev-loop paper cut:
the runner's kept answers (`exact.kept.*`) live in the same Keychain service
and multiply the prompts.

