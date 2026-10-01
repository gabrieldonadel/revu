# LLP 0002: GitHub authentication is the browser flow with a loopback callback; the device code is the fallback

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

## Revision 3 (2026-09-30): the token in the app's own store while builds are ad-hoc signed

Gabriel: "I can't keep reentering the password all the time." While there is
no signing identity, each rebuild is a new app to the Keychain and reading
the item asks for the login password. So `app.ts` keeps the token in the
app's SQLite (`settings.github.token`, under the app's data directory,
readable by the user account only) behind `TOKEN_IN_DB = true`; nothing is
written to the Keychain. The first seed came from the running app itself
(it hands the token to the sidecar at review time; `GET /auth/token` on
loopback read it back). Flip the flag to `false` for a signed build and the
Keychain (`secret.keep`) is the store again; the sidecar's loopback export
goes with it.

## Revision 4 (2026-09-30): a login button

Gabriel asked why a code and not a button. The answer was GitHub's rule
that the code → token exchange needs the **client secret** (PKCE is
"strongly recommended" in addition, never instead), and a desktop app has
nowhere safe for one. He ruled: the secret lives in a local `.env` for
development and as an EAS environment variable for the hosted exchange.

So the button is the browser flow with a loopback callback (GitHub
permits any port on a registered loopback callback URL):

1. `POST /oauth/start` on the sidecar makes `state` and a PKCE verifier and
   answers the `authorize` URL with `redirect_uri=http://127.0.0.1:<port>/oauth/callback`.
2. The app opens it (`openURL`); the user approves on GitHub; GitHub
   redirects to the sidecar's `/oauth/callback`, which shows a small page.
3. The sidecar exchanges the code: itself when `.env` holds
   `GITHUB_CLIENT_SECRET` (dev), else through the hosted endpoint
   (`github.oauthExchangeUrl` in `revu.config.json`, `exchange/` in this
   repo: an Expo Router API route on EAS Hosting that accepts only revu's
   loopback `redirect_uri` and keeps nothing).
4. The app polls `GET /oauth/result?state=` on its clock (alternating with
   the device-code poll) and stores the token as before.

The device code is started alongside and shown beneath the button, for a
machine where the browser cannot reach the sidecar's port. The OAuth app's
callback URL is `http://127.0.0.1/oauth/callback`.

Operational note (2026-10-01): EAS Hosting hands API routes only *plain
text* and *sensitive* variables — a *secret*-visibility variable never
reaches a deployment — and `eas deploy` must name the environment
(`--environment production`) for the variables to be bound. The secret was
set by Gabriel; `exchange/` is redeployed with
`bunx expo export --platform web && eas deploy --prod --environment production`.
