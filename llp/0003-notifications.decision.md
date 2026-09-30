# LLP 0003: Notifications go through `Exact.notifications`

**Type:** Decision
**Status:** Active (implemented 2026-09-30 as an app-owned module — no host change)
**Systems:** App, Notifications
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-28
**Related:** LLP 0001, expo/exact LLP 0570 (PR #79)

## Decision

New review requests raise a native notification with two actions, **Open**
and **Mark read**, from revu's own native module (Exact2 LLP 1067.000):
`revu-app/modules/apple/Notifier.swift` (`UNUserNotificationCenter`) and
`revu-app/modules/web/index.js` (the Notification API). `app.ts` asks it
over `native.later({ op: 'notify' })`; a user's answer comes back as a
device change (`context.changed('notifications')`) that the watching
`notificationActions` source drains and applies. Each request is announced
exactly once: the SQLite `announced` flag.

## Why

Exact2 has no host notification capability (2026-09-28), and its rules admit
host capabilities only behind consumers and a trade. LLP 1067.000 gives an
app one native module with a request/answer channel and a change
announcement, which is enough: the host is untouched, no waiver is needed,
and the module can later grow the menu bar item the same way. The design
carried over from expo/exact LLP 0570 (closed PR expo/exact#79): a
three-value permission that never manufactures a denial, foreground
presentation, per-notification action categories, an off-main response hop.

Under the agent driver the module substitutes: permission is granted, a
notification is remembered, and `simulate` plays an answer back, so drives
never prompt and stay repeatable.

## Consequences

- The window offers **Allow notifications** until permission is granted;
  announcing starts only once signed in.
- A click that cold-launches the app is not caught: the module loads after
  first pixel. Known, deferred.
- The sidecar never sends notifications itself.
