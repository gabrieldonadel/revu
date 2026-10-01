# LLP 0008: The landing page is an exact2 app built for the web

**Type:** Decision
**Status:** Active (placeholder page 2026-09-30; the design is to come)
**Systems:** Landing (`landing/`), Release
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-30
**Related:** LLP 0005 (the app's screens), LLP 0007 (releases)

## Decision

revu's website lives in this repo as a second exact2 app, `landing/`,
scaffolded with `exact new` and built for the web (`host/web`): one page,
the mark, the pitch, three cards, and a download button that names the
latest GitHub release (fetched from the API at load; `net.fetch
https://api.github.com` is its one grant). The tokens are the app's
(Expo design system, `light-dark()` pairs), so the page and the app read as
one thing. Gabriel sends the design later; what is here is the placeholder
that proves the pipeline.

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
