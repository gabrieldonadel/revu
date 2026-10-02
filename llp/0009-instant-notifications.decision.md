# LLP 0009: Instant notifications are Apple pushes from a GitHub App webhook

**Type:** Decision
**Status:** Active (server and app halves built 2026-10-01; live once the Apple and GitHub credentials are in place)
**Systems:** Exchange (EAS Hosting), Sidecar, App, Notifications, Release
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-10-01
**Related:** LLP 0003 (local notifications), LLP 0002 r4 (the hosted exchange), LLP 0007 (signing)

## Decision

GitHub has no push channel to a client: a user's notifications are polled
(`X-Poll-Interval`, 60 s, with free `304`s). Gabriel wanted instant, and
chose **APNs** over a webhook relay with an open socket: a push wakes the
app even when it is not running, and needs no connection kept alive.

The pieces:

- **A GitHub App "revu"** (Gabriel's to create), installed by each user on
  their repositories, delivers `pull_request` / `review_requested` to
  `POST https://revu-exchange.expo.app/webhooks/github`
  (`exchange/app/webhooks/github+api.ts`), HMAC-checked against
  `GITHUB_WEBHOOK_SECRET`.
- **A device registry** on the exchange (`exchange/lib/devices.ts`): APNs
  token → GitHub login. The Mac registers through its sidecar
  (`POST /push/register` → the exchange's `POST /devices`) sending its GitHub
  token once as proof; the exchange asks GitHub who it is and keeps only the
  login. Storage is **Supabase** (Postgres over PostgREST, the service-role
  key, table `revu_devices`, `exchange/supabase/schema.sql`) when
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are set — Gabriel's choice over
  Upstash, 2026-10-02 — else process memory (development; the app
  re-registers at every launch, so a redeploy only loses idle Macs until
  they next start).
- **An APNs sender** (`exchange/lib/apns.ts`): HTTP/2 to Apple with an
  ES256 provider token from `APNS_KEY` / `APNS_KEY_ID` / `APPLE_TEAM_ID`,
  topic `dev.donadel.revu`. A `410`/`BadDeviceToken` drops the device.
- **The app**: the module registers for remote notifications only when the
  binary carries the `aps-environment` entitlement (an ad-hoc build does
  not, and stays on polling); the device-token callbacks are added to
  ExactMac's application delegate at load, as the quit answer was (LLP 0006
  D3). The token reaches the plan as a device change on the `push` topic;
  a push received while running moves a stamp the inbox depends on, so the
  list refreshes at once. The OS shows the push's own alert; the banner
  with Open / Mark read (LLP 0003) follows from the refreshed inbox.
- **Settings ▸ General** shows "Instant notifications: on (Apple push)" or
  the reason it is not.

## What it needs from Gabriel

1. ~~A **Developer ID Application** certificate on the build Mac~~ — done
   2026-10-02 (team 3VRHBFMBRL), and the **Team ID** with it.
1b. A **Developer ID provisioning profile** for `dev.donadel.revu` with the
   Push Notifications capability, embedded as
   `Contents/embedded.provisionprofile` (`REVU_PROVISION_PROFILE` for
   `package.sh --release`). Found the hard way: `aps-environment` is a
   provisioned entitlement; a Developer ID signature alone makes the kernel
   refuse the launch (POSIX 163), while the same app without the entitlement
   opens. Developer site → Identifiers (App ID `dev.donadel.revu`, enable
   Push Notifications) → Profiles → "+" → Developer ID → macOS.
2. ~~The **Team ID**.~~
3. ~~An **APNs auth key**~~ — in EAS 2026-10-02 (`APNS_KEY`, `APNS_KEY_ID`
   YFLB85X9N5, `APPLE_TEAM_ID`). Verified from the deployment: `GET
   /apns/check?key=<webhook secret>` sends to an all-zero token and Apple
   answers `BadDeviceToken`, which proves the provider token, the topic and
   the HTTP/2 transport (Bun's own `fetch` cannot speak HTTP/2 to APNs; the
   EAS runtime's can).
4. ~~The **GitHub App**'s webhook secret~~ — in EAS 2026-10-02. A signed
   `ping` answers `pong`; a signed `review_requested` for a login answers
   with the device count. The GitHub App must then be **installed** on the
   repositories whose requests should push.

Team review requests (`requested_team`) are not fanned out yet: the webhook
has no team membership; a later revision can ask the GitHub App's
installation token for the team's members.

## Consequences

- Users who do not install the GitHub App keep the 60-second poll.
- `scripts/package.sh` must sign with the Developer ID and an entitlements
  file carrying `aps-environment = production`, then notarize; until then
  the release stays ad-hoc and polling.
