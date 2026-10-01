# LLP 0008: The landing page is an exact2 app built for the web

**Type:** Decision
**Status:** Active (the Claude Design file "Revu Landing Page" implemented 2026-09-30, live at gabrieldonadel-revu.expo.app)
**Systems:** Landing (`landing/`), Release
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-30
**Related:** LLP 0005 (the app's screens), LLP 0007 (releases)

## Decision

revu's website lives in this repo as a second exact2 app, `landing/`,
scaffolded with `exact new` and built for the web (`host/web`). It renders
the Claude Design file "Revu Landing Page" (same project as the app's
screens): header, hero with the Free / Open source soon badge, a desktop
mock of the review window and the popover (stills, sample data), How it
works (three cards), Skills (rules table and a skill file), Open source
(email + Notify me) and the footer — light only, as designed. The download
buttons name the latest GitHub release (`net.fetch https://api.github.com`
is the one grant). Not as designed: Maison Neue is not bundled (system-ui
stands in); the header is not sticky; the nav anchors scroll to measured
offsets (`scrollTop`) since Contract has no anchor links; "Notify me" opens
a prefilled mail to revu@donadel.dev — there is no backend for the list
yet.

## Why exact2 and not a static HTML page

Same language, same tokens, same build; the page can grow a live piece
(the release feed, a demo of the popover) without a second stack. exact2
treats Chrome as its reference renderer, so the web output is first-class.

## Build and host

`bun run landing:web` is the dev loop; `bun run landing:build` writes
`landing/target/web-dist` (index.html, glue.js, app.wasm). Hosting is EAS
Hosting (ruled 2026-09-30): `landing/hosting/` is the EAS project
(`@gabrieldonadel/revu`, static output); `bun run landing:deploy` exports
nothing of its own and deploys `web-dist` as the production deployment.
EAS serves `.wasm` as `application/wasm`, which the page needs.

The release lookup needs the releases to be public (an unauthenticated
API call on a private repository is a 404; so is downloading its assets) —
LLP 0007's open question, Gabriel's to settle.
