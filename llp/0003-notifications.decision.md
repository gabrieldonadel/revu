# LLP 0003: Notifications go through `Exact.notifications`

**Type:** Decision
**Status:** Active
**Systems:** App, Notifications
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-28
**Related:** LLP 0001, expo/exact LLP 0570 (PR #79)

## Decision

New review requests raise a native macOS notification through
`Exact.notifications.send()` with two actions: **Open** (opens the pull
request) and **Mark read**. Responses arrive on `Exact.notifications.on('action')`.

## Why

expo/exact LLP 0570 wires `Exact.notifications` to `UNUserNotificationCenter`
on macOS: real banners while the app is frontmost, action buttons, and the
response callback. revu's runtime is linked to that branch, so no `osascript`
sidecar path is needed.

## Consequence

The app must call `requestPermission()` once, before the first `send()`; the
setup screen does this. The sidecar never sends notifications itself.
