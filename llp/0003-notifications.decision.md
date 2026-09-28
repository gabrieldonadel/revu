# LLP 0003: Notifications go through `Exact.notifications`

**Type:** Decision
**Status:** Draft (blocked on an Exact2 capability; ask sent to Charlie 2026-09-28)
**Systems:** App, Notifications
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-28
**Related:** LLP 0001, expo/exact LLP 0570 (PR #79)

## Decision

New review requests raise a native macOS notification through
`Exact.notifications.send()` with two actions: **Open** (opens the pull
request) and **Mark read**. Responses arrive on `Exact.notifications.on('action')`.

## Why

Exact2 has no notification capability yet (2026-09-28); its `DEFERRED.md`
admits capabilities behind a real consumer, and revu is that consumer. The
design to carry over is expo/exact LLP 0570 (closed PR expo/exact#79):
async-only, a three-value permission, foreground presentation, action
categories, the off-main response hop. Until it lands, revu is a window you
look at; no `osascript` substitute is built.

## Consequence

The app must call `requestPermission()` once, before the first `send()`; the
setup screen does this. The sidecar never sends notifications itself.
