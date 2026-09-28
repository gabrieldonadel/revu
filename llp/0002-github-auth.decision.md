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
